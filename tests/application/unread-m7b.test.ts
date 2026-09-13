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
  base = await makeTempDir('unread-')
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

async function setup(): Promise<{ pid: string; sid: string }> {
  const created = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'u', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = created.json().project
  return { pid: p.id, sid: `u_${p.team[0].instanceId}` }
}

async function waitTurnEnd(pid: string, sid: string) {
  const deadline = Date.now() + 8000
  for (;;) {
    const log = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${sid}/log`,
    })
    const events = log.json().events as Array<{ kind: string; seq: number }>
    if (events.some((e) => e.kind === 'turn_end')) {
      // 先盘后推：log 先生效，meta.lastSeq 是投影、可能略滞后；等对账一致再断言未读
      const maxSeq = Math.max(...events.map((e) => e.seq))
      const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions` })
      const s = list.json().sessions.find((x: { id: string; lastSeq: number }) => x.id === sid)
      if (s && s.lastSeq >= maxSeq) return
    }
    if (Date.now() > deadline) throw new Error('等待回合超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('未读/已读回执', () => {
  it('新消息产生未读；标记已读后清零', async () => {
    const { pid, sid } = await setup()
    // 会话列表初始 unread=0
    let list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions` })
    let s0 = list.json().sessions.find((x: { id: string }) => x.id === sid)
    expect(s0.unread).toBe(0)

    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/messages`,
      payload: { text: 'hello' },
    })
    await waitTurnEnd(pid, sid)

    list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions` })
    s0 = list.json().sessions.find((x: { id: string }) => x.id === sid)
    expect(s0.unread).toBeGreaterThan(0)

    const read = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/sessions/${sid}/read`,
      payload: { seq: s0.lastSeq },
    })
    expect(read.json().session.unread).toBe(0)
    const again = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions` })
    expect(again.json().sessions.find((x: { id: string }) => x.id === sid).unread).toBe(0)
  })

  it('会话详情带 unread 与 readSeq', async () => {
    const { pid, sid } = await setup()
    const d = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}` })
    const session = d.json().session
    expect(typeof session.unread).toBe('number')
    expect(typeof session.readSeq).toBe('number')
  })
})
