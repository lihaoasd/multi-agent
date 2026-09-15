import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface DownlinkFrame {
  type: string
  payload: Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, diagnostics?: () => string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const extra = diagnostics === undefined ? '' : `｜已收到：${diagnostics()}`
  throw new Error(`等待条件超时${extra}`)
}

describe('WS 网关（先盘后推 + 上行 send/subscribe）', () => {
  let context: TestContext
  let projectId: string
  let socket: WebSocket
  let frames: DownlinkFrame[]
  let baseUrl: string

  beforeAll(async () => {
    context = await createTestServer()
    const workdir = mkdtempSync(join(tmpdir(), 'ah-ws-workdir-'))
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'WS 演示', workdir },
    })
    projectId = created.json<{ id: string }>().id

    baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 })
    frames = []
    socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws?projectId=${projectId}`)
    socket.on('message', (raw: unknown) => {
      frames.push(JSON.parse(String(raw)) as DownlinkFrame)
    })
    await once(socket, 'open')
    await waitFor(() => frames.some((frame) => frame.type === 'ws.ready'))
  })

  afterAll(async () => {
    socket.close()
    await context.cleanup()
  })

  it('连接即订阅项目：ready 帧带 clientId 与 projectId', () => {
    const ready = frames.find((frame) => frame.type === 'ws.ready')
    expect(ready?.payload['projectId']).toBe(projectId)
    expect(typeof ready?.payload['clientId']).toBe('string')
    expect(context.deps.realtime.clientCount()).toBe(1)
    expect(context.deps.realtime.subscriberCount(projectId)).toBe(1)
  })

  it('ping → pong', async () => {
    socket.send(JSON.stringify({ type: 'ping' }))
    await waitFor(() => frames.some((frame) => frame.type === 'pong'))
    expect(frames.some((frame) => frame.type === 'pong')).toBe(true)
  })

  it('上行 send：消息落盘 → 推送 event.appended / message.commit / agent.state', async () => {
    socket.send(
      JSON.stringify({ type: 'send', payload: { projectId, sessionId: 'u_dev_1', text: '通过 WS 发一条' } }),
    )
    await waitFor(
      () => frames.some((frame) => frame.type === 'message.accepted'),
      3000,
      () => frames.map((frame) => `${frame.type}:${JSON.stringify(frame.payload)}`).join(' | '),
    )
    await waitFor(
      () => frames.some((frame) => frame.type === 'event.appended'),
      3000,
      () => {
        const types = frames.map((frame) => frame.type).join(',')
        return `${types}｜hub 客户端=${context.deps.realtime.clientCount()}｜订阅=${context.deps.realtime.subscriberCount(projectId)}`
      },
    )

    const accepted = frames.find((frame) => frame.type === 'message.accepted')
    expect(accepted?.payload).toMatchObject({ sessionId: 'u_dev_1', seq: 1, queued: false })

    // 事件按 seq 顺序推送，且覆盖一个完整回合
    const appended = frames.filter((frame) => frame.type === 'event.appended').map((frame) => frame.payload['seq'])
    expect(appended.slice(0, 5)).toEqual([1, 2, 3, 4, 5])
    const kinds = frames.filter((frame) => frame.type === 'event.appended').map((frame) => frame.payload['kind'])
    expect(kinds.slice(0, 5)).toEqual(['message', 'turn_start', 'thought', 'message', 'turn_end'])

    const commits = frames.filter((frame) => frame.type === 'message.commit')
    expect(commits.length).toBeGreaterThanOrEqual(2) // 用户消息 + 占位回复

    const states = frames.filter((frame) => frame.type === 'agent.state').map((frame) => frame.payload['state'])
    expect(states).toContain('working')
    expect(states).toContain('idle')

    // 先盘后推：收到 message.commit 时该 seq 必须已在磁盘上
    const log = await context.deps.sessionLogStore.readWindow(projectId, 'u_dev_1')
    expect(log.ok).toBe(true)
    if (log.ok) {
      const maxSeqOnDisk = Math.max(...log.value.map((event) => event.seq))
      for (const commit of commits) {
        expect(Number(commit.payload['seq'])).toBeLessThanOrEqual(maxSeqOnDisk)
      }
    }
  })

  it('订阅隔离：未订阅项目的连接收不到该项目的团队事件', async () => {
    const otherProject = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '另一个项目', workdir: mkdtempSync(join(tmpdir(), 'ah-ws-other-')) },
    })
    const otherId = otherProject.json<{ id: string }>().id
    const before = frames.length
    await context.app.inject({ method: 'POST', url: `/api/projects/${otherId}/team/qa_1/pause` })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const newFrames = frames.slice(before).filter((frame) => frame.type === 'team.updated')
    expect(newFrames).toEqual([])
  })

  it('未知上行帧 → error 帧（连接不断）', async () => {
    socket.send(JSON.stringify({ type: 'nonsense' }))
    await waitFor(() => frames.some((frame) => frame.type === 'error'))
    expect(frames.some((frame) => frame.type === 'error')).toBe(true)
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('断开后从注册表移除', async () => {
    const second = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws?projectId=${projectId}`)
    await once(second, 'open')
    await waitFor(() => context.deps.realtime.clientCount() === 2)
    second.close()
    await waitFor(() => context.deps.realtime.clientCount() === 1)
    expect(context.deps.realtime.clientCount()).toBe(1)
  })
})
