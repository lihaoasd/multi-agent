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
  base = await makeTempDir('m8e-')
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

async function makeProject(roles: string[]): Promise<{ pid: string; ids: string[] }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'm8e', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  return { pid: p.id, ids: p.team.map((m: { instanceId: string }) => m.instanceId) }
}

describe('纪要转任务（D17-⑦）+ plan 事件', () => {
  it('closed 会议纪要一键转出任务（creator=user，来源本会议）', async () => {
    const { pid, ids } = await makeProject(['pm', 'dev'])
    const [pm, dev] = ids
    const mt = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: '评审登录', members: [dev] },
    })
    const mid = mt.json().meeting.id
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/close`,
      payload: { actor: 'user' },
    })
    const made = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/minutes/tasks`,
      payload: { assignee: dev, title: '按纪要实现认证' },
    })
    expect(made.statusCode).toBe(200)
    expect(made.json().task.id).toMatch(/^t_/)

    const tasks = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/tasks` })
    const t = tasks.json().tasks.find((x: { id: string }) => x.id === made.json().task.id)
    expect(t.title).toBe('按纪要实现认证')
    expect(t.creator).toBe('user')
    expect(t.assignee).toBe(dev)
    expect(t.sessionId).toBe(mid)
    expect(t.desc).toContain('评审登录')

    // 未结束会议不可转出
    const mt2 = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'x', members: [dev] },
    })
    const early = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mt2.json().meeting.id}/minutes/tasks`,
      payload: { assignee: dev },
    })
    expect(early.statusCode).toBe(409)
  })

  it('plan-execute 角色回合落 plan 事件（dev 默认 plan-execute）', async () => {
    const { pid, ids } = await makeProject(['dev'])
    const dev = ids[0]
    const sid = `u_${dev}`
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: '开始任务' },
    })
    const deadline = Date.now() + 8000
    for (;;) {
      const log = await ready().inject({
        method: 'GET',
        url: `/api/projects/${pid}/sessions/${sid}/log`,
      })
      const evts = log.json().events
      const hasPlan = evts.some((e: { kind: string }) => e.kind === 'plan')
      const end = evts.some((e: { kind: string }) => e.kind === 'turn_end')
      if (hasPlan && end) {
        const plan = evts.find((e: { kind: string }) => e.kind === 'plan')
        expect(plan.payload.status).toBe('executing')
        expect(plan.payload.steps).toHaveLength(1)
        return
      }
      if (Date.now() > deadline) throw new Error('等待 plan/turn_end 超时')
      await new Promise((r) => setTimeout(r, 30))
    }
  })
})
