import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, composeToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { executeTool } from '../src/infra/tools/executor.js'
import type { ToolEnv } from '../src/infra/tools/executor.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('code-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
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

async function makeSvc() {
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  const svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
  return svc
}

async function setup(): Promise<{
  svc: ReturnType<typeof composeServices>
  pid: string
  dev: string
  runtime: string
}> {
  const svc = await makeSvc()
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'codeapp', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return {
    svc,
    pid: p.id,
    dev: p.team[0].instanceId,
    runtime: join(base, 'data', 'projects', p.id),
  }
}

describe('code 受控编辑通道（workdir_edit → 任务级聚合结算）', () => {
  it('workdir_edit 写/替换 workdir 文件并留轨迹；task done 结算为 code artifact', async () => {
    const { svc, pid, dev, runtime } = await setup()
    const env: ToolEnv = await composeToolEnv(svc, pid, dev)

    // 创建任务 → in_progress（聚合归属 taskId）
    const t = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '实现登录页', assignee: dev },
    })
    const tid = t.json().task.id
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'in_progress' },
    })

    // 受控编辑：写新文件
    const w = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://src/login.ts',
        edits: [{ type: 'write', text: 'export function login() { return true }\n' }],
        taskId: tid,
      },
      env,
    )
    expect(w.ok).toBe(true)
    // 受控编辑：替换已有文件
    const r = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://src/login.ts',
        edits: [{ type: 'replace', oldText: 'return true', newText: 'return !!token' }],
        taskId: tid,
      },
      env,
    )
    expect(r.ok).toBe(true)
    // 替换目标不存在 → ERR_CONFLICT
    const conflict = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://src/login.ts',
        edits: [{ type: 'replace', oldText: '不存在内容', newText: 'x' }],
        taskId: tid,
      },
      env,
    )
    expect(conflict.ok).toBe(false)
    expect(conflict.ok === false && conflict.code).toBe('ERR_CONFLICT')
    // 越界路径拒绝
    const outside = await executeTool(
      'workdir_edit',
      { path: 'ws://x.ts', edits: [{ type: 'write', text: 'x' }] },
      env,
    )
    expect(outside.ok).toBe(false)

    // task done → settle：workdir 文件已写入，结算出 code artifact v1
    const done = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'done', actor: 'user' },
    })
    expect(done.statusCode).toBe(200)

    const arts = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/artifacts` })
    const codeArt = arts
      .json()
      .artifacts.find(
        (a: { type: string; taskId: string }) => a.type === 'code' && a.taskId === tid,
      )
    expect(codeArt).toBeTruthy()
    expect(codeArt.files.some((f: { relPath: string }) => f.relPath === 'src/login.ts')).toBe(true)
    // workdir 中内容为替换后结果
    const content = await import('node:fs/promises').then((f) =>
      f.readFile(join(workdir, 'src', 'login.ts'), 'utf8'),
    )
    expect(content).toContain('!!token')
    // 轨迹已清空（结算后删除）
    const trail = join(runtime, 'code-edits', `${tid}.jsonl`)
    await expect(import('node:fs/promises').then((f) => f.access(trail))).rejects.toThrow()
  })

  it('terminated 同样先结算再置终态', async () => {
    const { svc, pid, dev } = await setup()
    const env: ToolEnv = await composeToolEnv(svc, pid, dev)
    const t = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '改 bug', assignee: dev },
    })
    const tid = t.json().task.id
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'in_progress' },
    })
    await executeTool(
      'workdir_edit',
      { path: 'workdir://fix.ts', edits: [{ type: 'write', text: '// fix\n' }], taskId: tid },
      env,
    )
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'terminated', actor: 'user' },
    })
    const arts = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/artifacts` })
    const codeArt = arts
      .json()
      .artifacts.find(
        (a: { type: string; taskId: string }) => a.type === 'code' && a.taskId === tid,
      )
    expect(codeArt).toBeTruthy()
  })

  it('无任务(未指派 taskId)的编辑按 untracked_<iid> 兜底，不结算成 artifact', async () => {
    const { svc, pid, dev } = await setup()
    const env: ToolEnv = await composeToolEnv(svc, pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://scratch.ts', edits: [{ type: 'write', text: 'x' }] },
      env,
    )
    const arts = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/artifacts` })
    expect(arts.json().artifacts).toHaveLength(0)
    // 兜底轨迹存在（无任务按回合，M 后续可结算）
    const trail = join(base, 'data', 'projects', pid, 'code-edits', `untracked_${dev}.jsonl`)
    await expect(import('node:fs/promises').then((f) => f.access(trail))).resolves.toBeUndefined()
  })

  it('meeting 会话不可用 workdir_edit', async () => {
    const { svc, pid, dev } = await setup()
    const env: ToolEnv = { ...(await composeToolEnv(svc, pid, dev)), sessionType: 'meeting' }
    const res = await executeTool(
      'workdir_edit',
      { path: 'workdir://a.ts', edits: [{ type: 'write', text: 'x' }] },
      env,
    )
    expect(res.ok).toBe(false)
  })
})
