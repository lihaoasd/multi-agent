import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('m6-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  // 本文件验证**手动推进**的会议状态机（proposed → accept → open → 决策点 → close）：
  // 关掉自动开始/自动收尾，避免受邀成员到位后平台立刻把会议跑完（端到端链路见 meeting-queue-m8z）。
  config.meeting = { autoStart: false, autoClose: false }
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

async function createProject(roles: string[]): Promise<{ pid: string; ids: string[] }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'meet', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  return { pid: p.id, ids: p.team.map((m: { instanceId: string }) => m.instanceId) }
}

describe('M6 会议机制', () => {
  it('发起(proposed) → 成员接受(open) → 决策点阻塞 → 用户答复 → 结束纪要回写', async () => {
    const { pid, ids } = await createProject(['pm', 'dev'])
    const [pm, dev] = ids

    const create = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: {
        host: pm,
        topic: '技术评审',
        desc: '评审登录方案的技术选型与风险，产出结论',
        agenda: ['评审登录方案'],
        members: [dev],
      },
    })
    expect(create.statusCode).toBe(201)
    const mid = create.json().meeting.id
    expect(create.json().meeting.state).toBe('proposed')
    expect(create.json().meeting.meeting.desc).toBe('评审登录方案的技术选型与风险，产出结论')

    // 主题 + 描述可从会话详情读回（会议窗口顶部展示用）
    const detail = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${mid}`,
    })
    expect(detail.json().session.meeting.topic).toBe('技术评审')
    expect(detail.json().session.meeting.desc).toBe('评审登录方案的技术选型与风险，产出结论')

    // 成员接受 → open
    const accept = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    expect(accept.json().meeting.state).toBe('open')

    // 主持人问决策点 → blocked
    const ask = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/ask`,
      payload: { asker: pm, question: '采用方案 A 还是 B？', options: ['A', 'B'] },
    })
    const qid = ask.json().decisionPoint.id
    expect(ask.json().decisionPoint.status).toBe('pending')
    const afterAsk = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/meetings`,
    })
    const m = afterAsk.json().meetings.find((x: { id: string }) => x.id === mid)
    expect(m.state).toBe('blocked_waiting_user')

    // 非主持人 ask 拒绝；重复 pending 拒绝
    const badAsk = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/ask`,
      payload: { asker: dev, question: 'x' },
    })
    expect(badAsk.statusCode).toBe(403)

    // 用户答复 → open
    const ans = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/decision`,
      payload: { questionId: qid, choice: 'A', text: '选 A' },
    })
    expect(ans.json().meeting.state).toBe('open')

    // 结束 → 纪要生成 + 记忆回写
    const close = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/close`,
      payload: { actor: 'user' },
    })
    expect(close.json().meeting.state).toBe('closed')
    const minutes = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/meetings/${mid}/minutes`,
    })
    expect(minutes.statusCode).toBe(200)
    expect(minutes.json().minutes.text).toContain('选 A')

    const mem = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/memories?scope=global`,
    })
    expect(
      mem.json().entries.some((e: { content: string }) => e.content.includes('技术评审')),
    ).toBe(true)
  })

  it('MVP 并发：占槽时新发起落 queued；关闭后自动转 proposed', async () => {
    const { pid, ids } = await createProject(['pm', 'dev', 'qa'])
    const [pm, dev, qa] = ids
    const first = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'm1', members: [dev] },
    })
    const mid1 = first.json().meeting.id
    // 第一个会议 open 后再发起第二个（占槽）
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid1}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    const second = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: qa, topic: 'm2', members: [pm] },
    })
    expect(second.json().meeting.state).toBe('queued')
    const mid2 = second.json().meeting.id

    // 结束第一个会议 → 槽位空出 → queued 自动转 proposed（D16-①）
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid1}/close`,
      payload: { actor: 'user' },
    })
    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    const m2 = list.json().meetings.find((m: { id: string }) => m.id === mid2)
    expect(m2.state).toBe('proposed')
  })

  it('成员回应聚合阵容消息（lineup 事件，D17-②）', async () => {
    const { pid, ids } = await createProject(['pm', 'dev', 'qa'])
    const [pm, dev, qa] = ids
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: '评审', members: [dev, qa] },
    })
    const mid = created.json().meeting.id
    // dev 稍后 → 未 open；qa 接受 → open，聚合阵容（accept=[qa], later=[dev]）
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'later' },
    })
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: qa, decision: 'accept' },
    })
    const log = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${mid}/log`,
    })
    const lineup = log
      .json()
      .events.filter((e: { payload?: { action?: string } }) => e.payload?.action === 'lineup')
    expect(lineup.length).toBeGreaterThan(0)
    const last = lineup[lineup.length - 1].payload
    expect(last.accepted).toContain(qa)
    expect(last.later).toContain(dev)
  })

  it('取消 queued/proposed 会议', async () => {
    const { pid, ids } = await createProject(['pm', 'dev'])
    const [pm, dev] = ids
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'x', members: [dev] },
    })
    const mid = created.json().meeting.id
    const cancel = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/cancel`,
      payload: { actor: 'user' },
    })
    expect(cancel.statusCode).toBe(200)
    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    expect(list.json().meetings[0].state).toBe('closed')
  })

  it('校验：无成员/成员含主持人/重复回应', async () => {
    const { pid, ids } = await createProject(['pm', 'dev'])
    const [pm, dev] = ids
    const bad = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'x', members: [] },
    })
    expect(bad.statusCode).toBe(400)
    const bad2 = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'x', members: [pm] },
    })
    expect(bad2.statusCode).toBe(400)

    const ok = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'ok', members: [dev] },
    })
    const mid = ok.json().meeting.id
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    const dup = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    expect(dup.statusCode).toBe(409)
  })
})
