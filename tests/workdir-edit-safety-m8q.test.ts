/**
 * 数据安全回归（M8Q，2026-09-12）：`workdir_edit` 不能再把文件清空。
 *
 * 真实事故：模型发 `{oldText,newText}` 漏了 `type`，旧实现缺省当 `write` 且 `text` 缺失 →
 * 直接把 7742 字的 docs/prd.md 写成 0 字节（回执还显示"无净变化"），模型随后以为文件损坏、
 * 反复读文件核对，最终既没上报任务状态也没给总结。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  base = await makeTempDir('safety-')
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
    payload: { name: 'safety', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: p.team[0].instanceId as string }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

const content = (rel: string) => readFile(join(workdir, rel), 'utf8')

describe('workdir_edit 数据安全：不会误清空文件', () => {
  it('编辑漏 type 但给了 oldText/newText → 按 replace 处理（不再写成空文件）', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/prd.md', edits: [{ type: 'write', text: '# PRD v1\n正文甲\n正文乙\n' }] },
      e,
    )
    // 真实事故形态：没有 type，只有 oldText/newText
    const r = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://docs/prd.md',
        edits: [{ oldText: '正文甲', newText: '正文甲（已定稿）' }],
      },
      e,
    )
    expect(r.ok).toBe(true)
    expect(await content('docs/prd.md')).toBe('# PRD v1\n正文甲（已定稿）\n正文乙\n')
  }, 20000)

  it('write 缺 text → 拒绝且文件不变（旧实现会写空）', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/a.md', edits: [{ type: 'write', text: '重要内容\n' }] },
      e,
    )
    const bad = await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/a.md', edits: [{ type: 'write' }] },
      e,
    )
    expect(bad.ok).toBe(false)
    expect(bad.ok ? '' : bad.code).toBe('ERR_VALIDATION')
    expect(bad.ok ? '' : bad.reason).toContain('缺少 text')
    expect(await content('docs/a.md')).toBe('重要内容\n')
  }, 20000)

  it('write 的 text 为空 → 拒绝且文件不变', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/b.md', edits: [{ type: 'write', text: 'x\n' }] },
      e,
    )
    const bad = await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/b.md', edits: [{ type: 'write', text: '' }] },
      e,
    )
    expect(bad.ok).toBe(false)
    expect(bad.ok ? '' : bad.reason).toContain('空内容')
    expect(await content('docs/b.md')).toBe('x\n')
  }, 20000)

  it('既无 type 也无任何字段 → 明确报错（而不是写空）', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/c.md', edits: [{ type: 'write', text: 'y\n' }] },
      e,
    )
    const bad = await executeTool('workdir_edit', { path: 'workdir://docs/c.md', edits: [{}] }, e)
    expect(bad.ok).toBe(false)
    expect(await content('docs/c.md')).toBe('y\n')
  }, 20000)

  it('replace 目标不存在 → 整笔事务不改文件（原有语义保持）', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/d.md', edits: [{ type: 'write', text: '原文\n' }] },
      e,
    )
    const bad = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://docs/d.md',
        edits: [
          { type: 'replace', oldText: '原文', newText: '改过' },
          { type: 'replace', oldText: '不存在', newText: 'x' },
        ],
      },
      e,
    )
    expect(bad.ok).toBe(false)
    expect(bad.ok ? '' : bad.code).toBe('ERR_CONFLICT')
    expect(await content('docs/d.md')).toBe('原文\n') // 前一替换也不生效（原子）
  }, 20000)

  it('大文件被"无 text 的 write"攻击时保持完好（事故文件形态复现）', async () => {
    const { pid, dev } = await setup()
    const e = await env(pid, dev)
    const big = `# 长文档\n${'正文行内容\n'.repeat(500)}`
    await writeFile(join(workdir, 'docs/big.md'), big, 'utf8').catch(async () => {
      await mkdir(join(workdir, 'docs'), { recursive: true })
      await writeFile(join(workdir, 'docs/big.md'), big, 'utf8')
    })
    const bad = await executeTool(
      'workdir_edit',
      { path: 'workdir://docs/big.md', edits: [{ newText: '**粗体**', oldText: '正文行内容' }] },
      e,
    )
    // 推断为 replace：只替换第一处，文件不会变空
    expect(bad.ok).toBe(true)
    const after = await content('docs/big.md')
    expect(after.length).toBeGreaterThan(1000)
    expect(after.startsWith('# 长文档')).toBe(true)
  }, 20000)
})
