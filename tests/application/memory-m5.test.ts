import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { MemoryStore } from '../../src/application/memory/memory-store.js'
import { createFileStorage } from '../../src/infra/store/file-store.js'
import { StorageFacade } from '../../src/infra/store/project-store.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

/** 测试用存储门面（重构 P1：store 不再吃 projectsRoot，改吃项目作用域门面）。 */
function makeFacade(projectsRoot: string): StorageFacade {
  const s = createFileStorage(projectsRoot)
  return new StorageFacade(s, s.root)
}

let base: string
let workdir: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('m5-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

async function setup(): Promise<{ pid: string; sid: string; iid: string }> {
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  const svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'm5', workdir, team: [{ roleTemplateId: 'product' }] },
  })
  const proj = created.json().project
  return { pid: proj.id, sid: `u_${proj.team[0].instanceId}`, iid: proj.team[0].instanceId }
}

function ready(): FastifyInstance {
  if (!app) throw new Error('app 未就绪（请先 setup()）')
  return app
}

function sendText(pid: string, sid: string, text: string) {
  return ready().inject({
    method: 'POST',
    url: `/api/projects/${pid}/sessions/${sid}/messages`,
    payload: { text },
  })
}

async function poll(pid: string, sid: string, pred: (evts: Array<{ kind: string }>) => boolean) {
  const deadline = Date.now() + 8000
  for (;;) {
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/${sid}/log`,
    })
    const events = res.json().events
    if (pred(events)) return events
    if (Date.now() > deadline) throw new Error('等待事件超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('M5 记忆与检索', () => {
  it('MemoryStore：全局/角色条目追加与 superseded', async () => {
    const cfg = loadConfig({ dataDir: join(base, 'data') }, base)
    const store = new MemoryStore(
      makeFacade(join(cfg.dataDir, 'projects')).forProjectsRoot(join(cfg.dataDir, 'projects')),
    )
    const g = await store.append(
      'p_x',
      {
        type: 'decision',
        content: '方案 A 定为基线',
        source: { sessionId: null, seq: null },
        tags: [],
        refs: [],
      },
      'global',
    )
    expect(g.id).toMatch(/^mem_/)
    await store.append(
      'p_x',
      {
        type: 'preference',
        content: '用户偏好中文注释',
        source: { sessionId: 'u_1', seq: 3 },
        tags: [],
        refs: [],
      },
      'role',
      'dev_1',
    )
    const actives = await store.listActive('p_x', { scope: 'global' })
    expect(actives.some((e) => e.content.includes('方案 A'))).toBe(true)
    await store.supersede('p_x', g.id, 'mem_x', 'global')
    const after = await store.listActive('p_x', { scope: 'global' })
    expect(after.find((e) => e.id === g.id)).toBeUndefined()
  })

  it('会话消息搜索：中文关键词命中并分组', async () => {
    const { pid, sid } = await setup()
    await sendText(pid, sid, '登录模块需要包含验证码功能')
    await poll(pid, sid, (e) => e.some((x) => x.kind === 'turn_end'))
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/search?q=${encodeURIComponent('验证码')}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sessions.length).toBeGreaterThan(0)
    const hits = body.sessions.flatMap((s: { hits: unknown[] }) => s.hits)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('搜索索引文件生成且可重建', async () => {
    const { pid, sid } = await setup()
    await sendText(pid, sid, '架构设计采用分层结构')
    await poll(pid, sid, (e) => e.some((x) => x.kind === 'turn_end'))
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/search?q=${encodeURIComponent('分层结构')}`,
    })
    expect(res.statusCode).toBe(200)
    const idx = join(base, 'data', 'projects', pid, 'search-index', 'idx.json')
    await import('node:fs/promises').then((f) => f.access(idx))
    // 索引可再生：删除后查询自动重建
    await import('node:fs/promises').then((f) => f.rm(idx, { force: true }))
    const res2 = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/search?q=${encodeURIComponent('分层结构')}`,
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.json().sessions.length).toBeGreaterThan(0)
  })

  it('GET /memories 返回全局条目', async () => {
    const { pid } = await setup()
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/memories?scope=global`,
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().entries)).toBe(true)
  })
})
