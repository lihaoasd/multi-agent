import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('mround-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  const svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

function ready(): FastifyInstance {
  if (!app) throw new Error('app not ready')
  return app
}

async function openMeeting(): Promise<{ pid: string; mid: string; pm: string; dev: string }> {
  const created = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'mr', workdir, team: [{ roleTemplateId: 'pm' }, { roleTemplateId: 'dev' }] },
  })
  const p = created.json().project
  const pm = p.team.find((t: { roleTemplateId: string }) => t.roleTemplateId === 'pm').instanceId
  const dev = p.team.find((t: { roleTemplateId: string }) => t.roleTemplateId === 'dev').instanceId
  const mt = await ready().inject({
    method: 'POST',
    url: `/api/projects/${p.id}/meetings`,
    payload: { host: pm, topic: '登录方案评审', agenda: ['评审认证方案'], members: [dev] },
  })
  const mid = mt.json().meeting.id
  await ready().inject({
    method: 'POST',
    url: `/api/projects/${p.id}/meetings/${mid}/respond`,
    payload: { member: dev, decision: 'accept' },
  })
  return { pid: p.id, mid, pm, dev }
}

async function pollMeetingLog(pid: string, mid: string, kind: string, sender?: string) {
  const deadline = Date.now() + 8000
  for (;;) {
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${mid}/log?kind=${kind}`,
    })
    const evts = res.json().events
    const hit = evts.some((e: { sender?: string }) => !sender || e.sender === sender)
    if (hit && evts.length > 0) return evts
    if (Date.now() > deadline) throw new Error('等待会议回合事件超时')
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function waitMeetingEvent(
  pid: string,
  mid: string,
  pred: (e: Record<string, unknown>) => boolean,
) {
  const deadline = Date.now() + 8000
  for (;;) {
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${mid}/log`,
    })
    const evts = (res.json().events as Array<Record<string, unknown>>).filter(pred)
    if (evts.length > 0) return evts
    if (Date.now() > deadline) throw new Error('等待会议事件超时')
    await new Promise((r) => setTimeout(r, 30))
  }
}

describe('会议轮次引擎（点名发言/插话/纪要重生成）', () => {
  it('主持人点名成员发言 → 成员在会议会话完成一轮（message+turn_end）', async () => {
    const { pid, mid, pm, dev } = await openMeeting()
    const talk = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/talk`,
      payload: { host: pm, member: dev, question: '请评估 token 方案' },
    })
    expect(talk.statusCode).toBe(200)
    // dev 在 meeting 会话产出 agent 消息并正常结束回合
    const agentMsgs = await waitMeetingEvent(
      pid,
      mid,
      (e) =>
        e.kind === 'message' &&
        e.role === 'agent' &&
        e.sender === dev &&
        String((e.content as { text?: string } | undefined)?.text ?? '').includes('Mock'),
    )
    const ends = await waitMeetingEvent(pid, mid, (e) => e.kind === 'turn_end')
    expect(agentMsgs.length).toBeGreaterThan(0)
    expect(ends.length).toBeGreaterThan(0)
  })

  it('非主持人不可点名；blocked 状态下点名被拒', async () => {
    const { pid, mid, pm, dev } = await openMeeting()
    const bad = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/talk`,
      payload: { host: dev, member: dev },
    })
    expect(bad.statusCode).toBe(403)
    // 主持人发起决策点 → blocked
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/ask`,
      payload: { asker: pm, question: '采用 A 还是 B？' },
    })
    const blocked = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/talk`,
      payload: { host: pm, member: dev },
    })
    expect(blocked.statusCode).toBe(409)
  })

  it('用户插话写入会议日志；结束后纪要可重新生成', async () => {
    const { pid, mid } = await openMeeting()
    const itj = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/messages`,
      payload: { text: '各位注意安全要求' },
    })
    expect(itj.statusCode).toBe(200)
    await pollMeetingLog(pid, mid, 'message', 'user')

    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/close`,
      payload: { actor: 'user' },
    })
    const regen = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/regenerate-minutes`,
    })
    expect(regen.statusCode).toBe(200)
    expect(regen.json().minutes.text).toContain('登录方案评审')
    // 未结束会议不可生成
    const { mid: mid2, pid: pid2 } = await openMeeting()
    const early = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid2}/meetings/${mid2}/regenerate-minutes`,
    })
    expect(early.statusCode).toBe(409)
  })
})
