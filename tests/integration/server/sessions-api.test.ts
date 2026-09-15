import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface SessionSummaryBody {
  sessionId: string
  instanceId: string
  displayName: string
  state: string
  lastSeq: number
  lastMessagePreview: string | null
}

interface AgentStatusBody {
  instanceId: string
  state: string
  paused: boolean
  queued: number
  sessionId: string | null
}

interface StoredEventBody {
  seq: number
  kind: string
  turn: number
  payload: Record<string, unknown>
}

describe('API · 会话与单工调度（规则 1/5/9）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const workdir = mkdtempSync(join(tmpdir(), 'ah-session-workdir-'))
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '会话演示', workdir },
    })
    projectId = created.json<{ id: string }>().id
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('项目创建即为每个实例建立 1:1 会话（u_<instanceId>）', async () => {
    const sessions = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions` })
    expect(sessions.statusCode).toBe(200)
    const list = sessions.json<SessionSummaryBody[]>()
    expect(list).toHaveLength(8)
    expect(list.map((item) => item.sessionId).sort()).toContain('u_dev_1')
    expect(list.every((item) => item.state === 'active')).toBe(true)
    expect(list.every((item) => item.lastSeq === 0)).toBe(true)
  })

  it('发消息：落 message(user) → 真实回合执行（turn_start … turn_end），先盘后推', async () => {
    const posted = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/messages`,
      payload: { text: '帮我拆一下登录模块' },
    })
    expect(posted.statusCode).toBe(202)
    expect(posted.json<{ seq: number; queued: boolean }>()).toMatchObject({ seq: 1, queued: false })

    const log = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
    const events = log.json<StoredEventBody[]>()
    const kinds = events.map((event) => event.kind)

    // 回合边界：turn_start 开启、turn_end 收尾（S4 起由真实 loop 产生，中间的 plan/thought/tool_* 取决于策略）
    expect(kinds[0]).toBe('message')
    expect(kinds[1]).toBe('turn_start')
    expect(kinds.at(-1)).toBe('turn_end')
    expect(kinds.filter((kind) => kind === 'turn_end')).toHaveLength(1)
    expect(kinds).toContain('message')

    // seq 连续：1..N 无空洞（先盘后推的分配口径）
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1))

    const userMessage = events[0]
    expect(userMessage?.payload['role']).toBe('user')
    const agentMessage = events.find((event) => event.kind === 'message' && event.payload['role'] === 'agent')
    expect(agentMessage).toBeDefined()
    expect(String(agentMessage?.payload['text']).length).toBeGreaterThan(0)
    expect(events.find((event) => event.kind === 'turn_start')?.payload['loopStep']).toBe('plan-execute')
  })

  it('会话窗口与按 kind 过滤', async () => {
    const detail = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1` })
    expect(detail.statusCode).toBe(200)
    const body = detail.json<{ meta: { lastSeq: number; segments: unknown[] }; events: StoredEventBody[] }>()
    expect(body.meta.lastSeq).toBe(body.events.length)
    expect(body.meta.segments).toHaveLength(1)

    const filtered = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/u_dev_1/log?kind=message,turn_end`,
    })
    const filteredKinds = filtered.json<StoredEventBody[]>().map((event) => event.kind)
    expect(filteredKinds.filter((kind) => kind === 'turn_end')).toHaveLength(1)
    expect(filteredKinds.filter((kind) => kind === 'message').length).toBeGreaterThanOrEqual(2)

    const fromSeq = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log?fromSeq=4` })
    expect(fromSeq.json<StoredEventBody[]>().map((event) => event.seq)).toEqual(
      body.events.slice(3).map((event) => event.seq),
    )
  })

  it('暂停 = 不再领新活：消息只入队；恢复后补处理（D18-③/D19-⑥）', async () => {
    const paused = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/qa_1/pause` })
    expect(paused.statusCode).toBe(200)
    expect(paused.json<AgentStatusBody>()).toMatchObject({ paused: true, state: 'idle', queued: 0 })

    const again = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/qa_1/pause` })
    expect(again.statusCode).toBe(409)

    const posted = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_qa_1/messages`,
      payload: { text: '写一份测试计划' },
    })
    expect(posted.statusCode).toBe(202)
    expect(posted.json<{ queued: boolean }>().queued).toBe(true)

    const statusesWhilePaused = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    const qaWhilePaused = statusesWhilePaused.json<AgentStatusBody[]>().find((item) => item.instanceId === 'qa_1')
    expect(qaWhilePaused).toMatchObject({ paused: true, queued: 1, state: 'idle' })

    const logWhilePaused = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_qa_1/log` })
    expect(logWhilePaused.json<StoredEventBody[]>().map((event) => event.kind)).toEqual(['message'])

    const resumed = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/qa_1/resume` })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json<{ handled: number }>().handled).toBe(1)

    const logAfterResume = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_qa_1/log` })
    const kinds = logAfterResume.json<StoredEventBody[]>().map((event) => event.kind)
    expect(kinds[0]).toBe('message')
    expect(kinds[1]).toBe('turn_start')
    expect(kinds.at(-1)).toBe('turn_end')
  })

  it('上下文完整性：重启后游标与队列可从磁盘重建（runtime.state + 会话日志）', async () => {
    const state = await context.deps.fileStore.readJson<{
      occupancy: Record<string, unknown>
      lastHandledSeq: Record<string, number>
      turns: Record<string, number>
    }>(`${context.dataDir}/projects/${projectId}/runtime.state.json`)
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.value.occupancy).toEqual({})
    // 游标指向“已处理到的用户消息 seq”：u_qa_1 的第一条消息 seq = 1
    expect(state.value.lastHandledSeq).toMatchObject({ qa_1: 1 })
    expect(state.value.turns['qa_1']).toBe(1)
  })

  it('停用实例：会话归档只读，写消息被拒；重新启用恢复', async () => {
    await inject({ method: 'DELETE', url: `/api/projects/${projectId}/team/ops_1` })
    const sessions = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions` })
    const ops = sessions.json<SessionSummaryBody[]>().find((item) => item.sessionId === 'u_ops_1')
    expect(ops?.state).toBe('archived')

    const blocked = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_ops_1/messages`,
      payload: { text: '部署一下' },
    })
    expect(blocked.statusCode).toBe(409)

    await inject({ method: 'POST', url: `/api/projects/${projectId}/team/ops_1/enable` })
    const after = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions` })
    expect(after.json<SessionSummaryBody[]>().find((item) => item.sessionId === 'u_ops_1')?.state).toBe('active')
  })

  it('消息校验：空消息与超长消息被拒', async () => {
    const empty = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '   ' },
    })
    expect(empty.statusCode).toBe(400)

    const tooLong = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: 'x'.repeat(20_001) },
    })
    expect(tooLong.statusCode).toBe(400)
  })

  it('不存在的会话 / 实例 → 404', async () => {
    const missingSession = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_ghost_1/messages`,
      payload: { text: 'hi' },
    })
    expect(missingSession.statusCode).toBe(404)

    const missingInstance = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/ghost_1/pause` })
    expect(missingInstance.statusCode).toBe(404)
  })
})
