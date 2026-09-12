/**
 * 产出物署名与归属锁（M8O，2026-09-12）：所有产出落项目目录 + 署名 + 其他人不能改。
 * 覆盖：首次写认领署名、同角色续写、他人写入被拒且文件未变、无主既有文件可写、
 * 他人产出物可读、另建新文件可行、artifact_submit 越权被拒、提示块 [我的产出物]/[他人产出物]、
 * 私有区工具已下线。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { AgentLoopRunner, type TurnContext } from '../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../src/infra/tools/executor.js'
import type { ChatMessage } from '../src/infra/model/provider.js'
import type { ModelGateway } from '../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('owner-')
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

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig; qa: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'owner',
      workdir,
      team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'qa' }],
    },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    dev: team.find((t) => t.roleTemplateId === 'dev')!,
    qa: team.find((t) => t.roleTemplateId === 'qa')!,
  }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

async function write(pid: string, iid: string, rel: string, text: string) {
  const e = await env(pid, iid)
  return executeTool(
    'workdir_edit',
    { path: `workdir://${rel}`, edits: [{ type: 'write', text }] },
    e,
  )
}

async function read(pid: string, iid: string, rel: string) {
  const e = await env(pid, iid)
  return executeTool('fs_read_file', { path: `workdir://${rel}` }, e)
}

describe('产出物署名与归属（项目目录是唯一产出地）', () => {
  it('首次写入即认领并署名；同一角色可续写（edits 累加）', async () => {
    const { pid, dev } = await setup()
    const w1 = await write(pid, dev.instanceId, 'src/a.ts', 'export const a = 1\n')
    expect(w1.ok).toBe(true)
    expect(w1.ok ? w1.summary : '').toContain('署名')

    const rec = await svc.fileOwners.get(pid, 'src/a.ts')
    expect(rec).toBeTruthy()
    expect(rec!.owner).toBe(dev.instanceId)
    expect(rec!.ownerName).toBe(dev.displayName)
    expect(rec!.via).toBe('workdir_edit')
    expect(rec!.edits).toBe(1)

    const w2 = await write(pid, dev.instanceId, 'src/a.ts', 'export const a = 2\n')
    expect(w2.ok).toBe(true)
    expect((await svc.fileOwners.get(pid, 'src/a.ts'))!.edits).toBe(2)
    expect(await readFile(join(workdir, 'src/a.ts'), 'utf8')).toBe('export const a = 2\n')
  }, 20000)

  it('他人产出物不可改：写入被拒 + 文件内容不变 + 可读', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'src/a.ts', 'dev-output\n')

    const denied = await write(pid, qa.instanceId, 'src/a.ts', 'qa-wants-to-overwrite\n')
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.code).toBe('ERR_FORBIDDEN')
    const reason = denied.ok ? '' : denied.reason
    expect(reason).toContain(dev.instanceId)
    expect(reason).toContain('不能修改他人产出物')
    expect(reason).toContain('另建新文件')

    expect(await readFile(join(workdir, 'src/a.ts'), 'utf8')).toBe('dev-output\n')
    expect((await svc.fileOwners.get(pid, 'src/a.ts'))!.owner).toBe(dev.instanceId)

    const r = await read(pid, qa.instanceId, 'src/a.ts')
    expect(r.ok).toBe(true)
  }, 20000)

  it('replace 也被拦（不是只有整文件覆盖会拦）', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'docs/x.md', '# title\nbody\n')
    const e = await env(pid, qa.instanceId)
    const denied = await executeTool(
      'workdir_edit',
      {
        path: 'workdir://docs/x.md',
        edits: [{ type: 'replace', oldText: 'body', newText: 'changed' }],
      },
      e,
    )
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.code).toBe('ERR_FORBIDDEN')
    expect(await readFile(join(workdir, 'docs/x.md'), 'utf8')).toBe('# title\nbody\n')
  }, 20000)

  it('另建新文件：他人产出物不能改，但可以写自己的新文件', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'src/snake.js', '// dev v1\n')
    const mine = await write(pid, qa.instanceId, 'src/snake.qa-notes.md', '// qa notes\n')
    expect(mine.ok).toBe(true)
    const owners = await svc.fileOwners.list(pid)
    expect(owners.map((o) => `${o.relPath}:${o.owner}`).sort()).toEqual([
      'src/snake.js:dev_1',
      'src/snake.qa-notes.md:qa_1',
    ])
  }, 20000)

  it('无主（用户既有）文件可写，写入后归写者所有', async () => {
    const { pid, qa } = await setup()
    await mkdir(join(workdir, 'legacy'), { recursive: true })
    await writeFile(join(workdir, 'legacy/old.txt'), 'user file\n', 'utf8')
    expect(await svc.fileOwners.get(pid, 'legacy/old.txt')).toBeNull()

    const w = await write(pid, qa.instanceId, 'legacy/old.txt', 'qa took over\n')
    expect(w.ok).toBe(true)
    expect((await svc.fileOwners.get(pid, 'legacy/old.txt'))!.owner).toBe(qa.instanceId)
  }, 20000)

  it('artifact_submit 不能把他人产出物登记成自己的；自己能登记', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'docs/prd.md', '# PRD\n')

    const qaEnv = await env(pid, qa.instanceId)
    const denied = await executeTool(
      'artifact_submit',
      { title: 'PRD', type: 'doc', path: 'docs/prd.md' },
      qaEnv,
    )
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.code).toBe('ERR_FORBIDDEN')
    expect(await svc.artifacts.list(pid)).toHaveLength(0)

    const devEnv = await env(pid, dev.instanceId)
    const ok = await executeTool(
      'artifact_submit',
      { title: 'PRD', type: 'doc', path: 'docs/prd.md' },
      devEnv,
    )
    expect(ok.ok).toBe(true)
    expect(await svc.artifacts.list(pid)).toHaveLength(1)
  }, 20000)

  it('GET /file-owners 列出署名与归属，可按 owner 过滤', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'src/a.ts', 'a\n')
    await write(pid, qa.instanceId, 'tests/a.test.ts', 'test\n')

    const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/file-owners` })
    expect(res.statusCode).toBe(200)
    const files = res.json().files as Array<{ relPath: string; owner: string; ownerName: string }>
    expect(files).toHaveLength(2)
    expect(files.every((f) => f.ownerName && f.ownerName !== '')).toBe(true)

    const onlyDev = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/file-owners?owner=${dev.instanceId}`,
    })
    expect(onlyDev.json().files).toHaveLength(1)
    expect(onlyDev.json().files[0].relPath).toBe('src/a.ts')
  }, 20000)

  it('系统提示注入 [我的产出物（可改）] 与 [他人产出物（只读）]', async () => {
    const { pid, dev, qa } = await setup()
    await write(pid, dev.instanceId, 'src/a.ts', 'a\n')
    await write(pid, qa.instanceId, 'tests/a.test.ts', 'test\n')

    const seen: ChatMessage[][] = []
    const gateway = {
      async *streamChat(opts: { messages: ChatMessage[] }) {
        seen.push(opts.messages)
        yield { content: '收到。' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: {
        listTools: () => [],
        exec: async () => ({ ok: true, summary: 'noop' }),
        fileOwnership: async (ctx) => {
          const all = await svc.fileOwners.list(ctx.projectId)
          return {
            mine: all
              .filter((r) => r.owner === ctx.member.instanceId)
              .map((r) => ({ relPath: r.relPath, lastAt: r.lastAt, lastTaskId: r.lastTaskId })),
            others: all
              .filter((r) => r.owner !== ctx.member.instanceId)
              .map((r) => ({
                relPath: r.relPath,
                owner: r.owner,
                ownerName: r.ownerName,
                lastAt: r.lastAt,
              })),
          }
        },
      },
    })
    const ctx: TurnContext = {
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'owner',
    }
    await loop.runDirectTurn(ctx)
    const system = String(seen[0]?.[0]?.content ?? '')
    expect(system).toContain('[我的产出物（可改）]')
    expect(system).toContain('src/a.ts')
    expect(system).toContain('[他人产出物（只读')
    expect(system).toContain('tests/a.test.ts')
    expect(system).toContain(qa.displayName)
  }, 20000)

  it('私有区工具已下线；所有产出走项目目录', async () => {
    expect(listToolDefs().some((d) => d.name === 'ws_write' || d.name === 'ws_read')).toBe(false)
    const { pid, dev } = await setup()
    const w = await write(pid, dev.instanceId, 'docs/prd.md', '# PRD\n')
    expect(w.ok).toBe(true)
    expect(await readFile(join(workdir, 'docs/prd.md'), 'utf8')).toBe('# PRD\n')
  }, 20000)
})
