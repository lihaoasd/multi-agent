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
  base = await makeTempDir('attn-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  // 本文件手动推进会议（造阻塞决策点）→ 关掉自动开始/自动收尾，避免会议被平台自动跑完
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
    payload: { name: 'attn', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  return { pid: p.id, ids: p.team.map((m: { instanceId: string }) => m.instanceId) }
}

describe('「需你处理」待办聚合（D17-③）', () => {
  it('阻塞会议决策与 pending 审批都会进入待办条；处理后消失', async () => {
    const { pid, ids } = await createProject(['pm', 'dev'])
    const [pm, dev] = ids

    // 会议阻塞拍板 → 待办
    const mt = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: '评审', members: [dev] },
    })
    const mid = mt.json().meeting.id
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/ask`,
      payload: { asker: pm, question: '采用方案？', options: ['A', 'B'] },
    })

    let items = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/needs-attention` })
    ).json().items
    expect(items.some((x: { kind: string }) => x.kind === 'meeting')).toBe(true)

    // 答复后消失
    const meetingList = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    ).json().meetings
    const m = meetingList.find((x: { id: string }) => x.id === mid)
    const qid = m.meeting.decisionPoints.find((d: { status: string }) => d.status === 'pending').id
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid}/decision`,
      payload: { questionId: qid, text: '选 A' },
    })
    items = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/needs-attention` })
    ).json().items
    expect(items.some((x: { kind: string }) => x.kind === 'meeting')).toBe(false)
  })

  it('无待办时为空数组', async () => {
    const { pid } = await createProject(['pm'])
    const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/needs-attention` })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([])
  })
})
