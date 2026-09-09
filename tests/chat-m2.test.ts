import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { makeTempDir } from './helpers.js'
import type { FastifyInstance } from 'fastify'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance

async function makeApp(): Promise<{ app: FastifyInstance; projectsRoot: string }> {
  base = await makeTempDir('chat-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  const svc = composeServices(config, join(base, 'roles'))
  const a = await buildApp(svc)
  return { app: a, projectsRoot: join(config.dataDir, 'projects') }
}

async function createProjectWithMember(name: string): Promise<{
  pid: string
  member: { instanceId: string; displayName: string }
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, workdir, team: [{ roleTemplateId: 'product' }] },
  })
  expect(res.statusCode).toBe(201)
  const body = res.json()
  return { pid: body.project.id, member: body.project.team[0] }
}

describe('M2 会话消息闭环（Mock 直答）', () => {
  beforeEach(async () => {
    const r = await makeApp()
    app = r.app
  })
  afterEach(async () => {
    await app?.close()
    if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
  })

  it('POST 消息 → 用户消息落盘 + Agent 回合事件完整（turn_start/message/turn_end）', async () => {
    const { pid, member } = await createProjectWithMember('demo')
    const sid = `u_${member.instanceId}`

    const send = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: '帮我写一个登录模块的需求' },
    })
    expect(send.statusCode).toBe(202)

    // 等待回合结束：轮询 log 直到出现 turn_end（同步 Mock 即刻返回，仍加轮询保险）
    const events = await pollForTurnEnd(pid, sid)
    const kinds = events.map((e: { kind: string }) => e.kind)
    expect(kinds).toContain('turn_start')
    expect(kinds).toContain('turn_end')
    const agentMsg = events.find(
      (e: { role?: string; kind: string }) => e.kind === 'message' && e.role === 'agent',
    )
    expect(agentMsg).toBeTruthy()
    expect(agentMsg!.content?.text).toContain('Mock')
    // seq 单调
    const seqs = events.map((e: { seq: number }) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('会话详情返回 meta + 消息；log 按 kind 过滤', async () => {
    const { pid, member } = await createProjectWithMember('demo2')
    const sid = `u_${member.instanceId}`
    await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: '你好' },
    })
    await pollForTurnEnd(pid, sid)
    const detail = await app.inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}` })
    expect(detail.statusCode).toBe(200)
    const body = detail.json()
    expect(body.session.type).toBe('user')
    expect(body.session.participants.agents).toEqual([member.instanceId])

    // log kind 过滤：agent message 至少 1 条
    const raw = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${sid}/log?kind=message`,
    })
    const msgs = raw.json().events
    expect(msgs.filter((e: { role: string }) => e.role === 'agent').length).toBeGreaterThan(0)
    expect(msgs.filter((e: { role: string }) => e.role === 'user')).toHaveLength(1)
  })

  it('重启恢复：新进程/新服务组合后历史仍在（先盘后推落盘）', async () => {
    const { pid, member } = await createProjectWithMember('demo3')
    const sid = `u_${member.instanceId}`
    await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: '重启测试' },
    })
    await pollForTurnEnd(pid, sid)
    await app.close()

    // 重新组装（模拟重启）
    const cfg = loadConfig({ dataDir: join(base, 'data') }, base)
    cfg.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
    const svc2 = composeServices(cfg, join(base, 'roles'))
    const app2 = await buildApp(svc2)
    try {
      const detail = await app2.inject({
        method: 'GET',
        url: `/api/projects/${pid}/sessions/${sid}`,
      })
      const msgs = detail.json().messages
      const texts = msgs
        .filter((e: { kind: string }) => e.kind === 'message')
        .map((e: { role: string; content: { text: string } }) => `${e.role}:${e.content.text}`)
      expect(texts.some((t: string) => t.startsWith('user:重启测试'))).toBe(true)
      expect(texts.some((t: string) => t.includes('Mock'))).toBe(true)
    } finally {
      await app2.close()
    }
  })

  it('停用实例后发送被拒 ERR_CONFLICT', async () => {
    const { pid, member } = await createProjectWithMember('demo4')
    const sid = `u_${member.instanceId}`
    await app.inject({ method: 'DELETE', url: `/api/projects/${pid}/team/${member.instanceId}` })
    const send = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: 'hi' },
    })
    expect(send.statusCode).toBe(409)
  })

  it('空消息/非法会话校验', async () => {
    const { pid, member } = await createProjectWithMember('demo5')
    const sid = `u_${member.instanceId}`
    const empty = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: '   ' },
    })
    expect(empty.statusCode).toBe(400)
    const nope = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/nope/messages`,
      payload: { text: 'x' },
    })
    expect(nope.statusCode).toBe(404)
  })
})

/** 轮询 log 直至出现 turn_end（同步 Mock 应立即完成）。 */
async function pollForTurnEnd(
  pid: string,
  sid: string,
): Promise<Array<{ kind: string; seq: number; role?: string; content?: { text: string } }>> {
  const deadline = Date.now() + 5000
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    const events = res.json().events
    if (events.some((e: { kind: string }) => e.kind === 'turn_end')) return events
    if (Date.now() > deadline) throw new Error('等待 turn_end 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}
