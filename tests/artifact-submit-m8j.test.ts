import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { executeTool } from '../src/infra/tools/executor.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('artifact-submit-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  svc = composeServices(config, join(base, 'roles'))
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

async function setup(): Promise<{ pid: string; dev: string }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'as', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  const dev = p.team[0].instanceId as string
  return { pid: p.id, dev }
}

const env = (pid: string, dev: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, dev, {
    sessionId: `u_${dev}`,
  })

async function exists(p: string): Promise<boolean> {
  return readFile(p, 'utf8').then(
    () => true,
    () => false,
  )
}

describe('产出物提交通道（artifact_submit 工具 → 项目工作目录）', () => {
  it('code 类：ws 私有区 → artifact_submit → 文件落入项目工作目录 + artifact approved', async () => {
    const { pid, dev } = await setup()
    // 1) 角色先在私有区写代码
    const w = await executeTool(
      'ws_write',
      { path: 'ws://src/snake.js', action: 'write', content: 'console.log(1)\n' },
      await env(pid, dev),
    )
    expect(w.ok).toBe(true)
    expect(await exists(join(workdir, 'src/snake.js'))).toBe(false) // 还没进项目目录

    // 2) 提交（code 门默认免审批）
    const sub = await executeTool(
      'artifact_submit',
      {
        title: '贪吃蛇核心代码',
        type: 'code',
        files: [{ fromWsRel: 'ws://src/snake.js', relPath: 'src/snake.js' }],
      },
      await env(pid, dev),
    )
    expect(sub.ok).toBe(true)
    const summary = sub.ok ? sub.summary : ''
    expect(summary).toContain('项目工作目录')
    expect(await readFile(join(workdir, 'src/snake.js'), 'utf8')).toBe('console.log(1)\n')
    const arts = await svc.artifacts.list(pid)
    expect(arts).toHaveLength(1)
    expect(arts[0]!.state).toBe('approved')
    expect(arts[0]!.files[0]!.relPath).toBe('src/snake.js')
  }, 20000)

  it('doc 类：提交后待审批（不落盘）→ 用户批准 → 落入项目工作目录', async () => {
    const { pid, dev } = await setup()
    await executeTool(
      'ws_write',
      { path: 'ws://docs/prd.md', action: 'write', content: '# 登录 PRD\n' },
      await env(pid, dev),
    )
    const sub = await executeTool(
      'artifact_submit',
      { title: '登录 PRD', type: 'doc', path: 'ws://docs/prd.md', relPath: 'docs/prd.md' },
      await env(pid, dev),
    )
    expect(sub.ok).toBe(true)
    const arts = await svc.artifacts.list(pid)
    expect(arts[0]!.state).toBe('submitted')
    const approvalId = arts[0]!.approvalId!
    expect(await exists(join(workdir, 'docs/prd.md'))).toBe(false) // 审批前不落盘

    // 用户批准 → 平台 finalize（此前漏了这一步，批准也不会落地）
    const decide = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/approvals/${approvalId}/decide`,
      payload: { decision: 'approved' },
    })
    expect(decide.statusCode).toBe(200)
    expect(await readFile(join(workdir, 'docs/prd.md'), 'utf8')).toBe('# 登录 PRD\n')
    expect((await svc.artifacts.list(pid))[0]!.state).toBe('approved')
  }, 20000)

  it('参数校验：无 files/path → 拒绝；源文件不存在 → 拒绝', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    const empty = await executeTool('artifact_submit', { title: 'x', type: 'doc' }, e)
    expect(empty.ok).toBe(false)
    const ghost = await executeTool(
      'artifact_submit',
      { title: 'x', type: 'doc', path: 'ws://nope.md' },
      e,
    )
    expect(ghost.ok).toBe(false)
  }, 20000)
})
