/**
 * 产出物登记（artifact_submit → 项目工作目录就地登记 + 版本快照 + 署名，2026-09-12 取消私有区）。
 */
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

/** 直接写工作目录文件（模拟角色已产出；所有权由 fileOwners 登记）。 */
const writeFileViaTool = async (pid: string, dev: string, rel: string, text: string) =>
  executeTool(
    'workdir_edit',
    { path: `workdir://${rel}`, edits: [{ type: 'write', text }] },
    await env(pid, dev),
  )

describe('产出物登记（工作目录就地 → manifest + 版本快照 + 署名）', () => {
  it('code 类：workdir_edit 写文件 → artifact_submit 登记 → approved + 署名 + 文件原地不动', async () => {
    const { pid, dev } = await setup()
    const w = await writeFileViaTool(pid, dev, 'src/snake.js', 'console.log(1)\n')
    expect(w.ok).toBe(true)
    expect(await exists(join(workdir, 'src/snake.js'))).toBe(true) // 产出直接落在项目目录

    const sub = await executeTool(
      'artifact_submit',
      {
        title: '贪吃蛇核心代码',
        type: 'code',
        files: [{ relPath: 'src/snake.js' }],
      },
      await env(pid, dev),
    )
    expect(sub.ok).toBe(true)
    const summary = sub.ok ? sub.summary : ''
    expect(summary).toContain('已登记产出物')
    expect(summary).toContain('署名')
    expect(await readFile(join(workdir, 'src/snake.js'), 'utf8')).toBe('console.log(1)\n')
    const arts = await svc.artifacts.list(pid)
    expect(arts).toHaveLength(1)
    expect(arts[0]!.state).toBe('approved')
    expect(arts[0]!.submitter).toBe(dev) // 署名
    expect(arts[0]!.files[0]!.relPath).toBe('src/snake.js')
    // 版本快照存在
    expect(
      await exists(join(base, 'data', 'projects', pid, arts[0]!.versionDir, 'src/snake.js')),
    ).toBe(true)
  }, 20000)

  it('doc 类：登记即完成（不需要审批）+ 归属记录含署名', async () => {
    const { pid, dev } = await setup()
    await writeFileViaTool(pid, dev, 'docs/prd.md', '# 登录 PRD\n')
    const sub = await executeTool(
      'artifact_submit',
      { title: '登录 PRD', type: 'doc', path: 'docs/prd.md' },
      await env(pid, dev),
    )
    expect(sub.ok).toBe(true)
    const arts = await svc.artifacts.list(pid)
    expect(arts[0]!.state).toBe('approved')
    expect(arts[0]!.approvalId).toBeNull()
    expect(await svc.approvals.list(pid, 'pending')).toHaveLength(0)

    const owners = await svc.fileOwners.list(pid)
    const rec = owners.find((o) => o.relPath === 'docs/prd.md')
    expect(rec).toBeTruthy()
    expect(rec!.owner).toBe(dev)
    expect(rec!.via).toBe('artifact_submit')
    expect(rec!.ownerName).not.toBe('') // 署名（显示名）
  }, 20000)

  it('参数校验：无 files/path → 拒绝；文件不存在 → 拒绝', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    const empty = await executeTool('artifact_submit', { title: 'x', type: 'doc' }, e)
    expect(empty.ok).toBe(false)
    const ghost = await executeTool(
      'artifact_submit',
      { title: 'x', type: 'doc', path: 'docs/nope.md' },
      e,
    )
    expect(ghost.ok).toBe(false)
  }, 20000)
})
