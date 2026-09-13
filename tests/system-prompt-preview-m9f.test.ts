/**
 * 「完整系统提示词」预览：GET /api/projects/:pid/agents/:iid/system-prompt（2026-09-13）。
 * 覆盖：段序与来源（实例提示词=role-config，其余=platform）、text=各段拼接、工具段与运行期口径一致、
 * 任务/产出物归属的实时注入、甲模式分派段只给 pm/product、实例不存在 404。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildToolEnv, composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { executeTool } from '../src/infra/tools/executor.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('prompt-preview-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  await boot()
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

/** 装配服务 + app（可切换甲模式：预览里的 [任务栏现状]/分派说明依赖它）。 */
async function boot(opts: { assignByAgent?: boolean } = {}): Promise<void> {
  config.task = { assignByAgent: opts.assignByAgent ?? false }
  await app?.close()
  app = null
  svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
}

function ready(): FastifyInstance {
  if (!app) throw new Error('app not ready')
  return app
}

async function setup(roles: string[]): Promise<{
  pid: string
  team: TeamMemberConfig[]
  id: (r: string) => string
}> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'prompt', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    team,
    id: (r: string) => team.find((t) => t.roleTemplateId === r)!.instanceId,
  }
}

interface PreviewBlock {
  id: string
  origin: 'role-config' | 'platform'
  title: string
  text: string
}
interface Preview {
  sessionType: string
  blocks: PreviewBlock[]
  text: string
}

async function preview(
  pid: string,
  iid: string,
): Promise<{ status: number; code?: string; preview: Preview }> {
  const res = await ready().inject({
    method: 'GET',
    url: `/api/projects/${pid}/agents/${iid}/system-prompt`,
  })
  const body = res.json()
  return { status: res.statusCode, code: body.code, preview: body.preview }
}

function blockOf(p: Preview, id: string): PreviewBlock {
  const b = p.blocks.find((x) => x.id === id)
  if (!b) throw new Error(`缺少提示词段: ${id}（现有：${p.blocks.map((x) => x.id).join(',')}）`)
  return b
}

describe('完整系统提示词预览', () => {
  it('段序固定：第 1 段是实例提示词（role-config），其余都是平台注入；text=各段拼接', async () => {
    const { pid, id } = await setup(['dev', 'pm'])
    const detail = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/agents/${id('dev')}`,
    })
    const { status, preview: p } = await preview(pid, id('dev'))
    expect(status).toBe(200)
    expect(p.sessionType).toBe('user')
    expect(p.blocks[0]!.id).toBe('instance-prompt')
    expect(p.blocks[0]!.origin).toBe('role-config')
    // 第 1 段就是角色详情里看到的实例提示词
    expect(p.blocks[0]!.text).toContain(detail.json().agent.prompt)
    expect(p.blocks.slice(1).every((b) => b.origin === 'platform')).toBe(true)
    // text 与 blocks 完全一致（同一份拼装）
    expect(p.text).toBe(p.blocks.map((b) => b.text).join('\n'))
    expect(p.text).toContain('[场景设定] 你是「高级开发」（项目：prompt）')
    expect(p.text).toContain('[执行模式] 先给出简短执行计划')
    expect(p.text).toContain('回复要求：')
    expect(p.text).toContain('[团队成员] 我：dev_1（高级开发）｜其他成员：pm_1（项目经理）')
  })

  it('工具段 = 运行期口径（与角色详情 effective 一致；pm 没有写/执行能力）', async () => {
    const { pid, id } = await setup(['dev', 'pm'])
    const devDetail = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/agents/${id('dev')}`,
    })
    const devNames: string[] = devDetail
      .json()
      .agent.tools.effective.map((t: { name: string }) => t.name)

    /** 工具段首行的"工具名清单"（到第一个句号为止；模板句里固定提到 cmd_run，不能整段断言）。 */
    const listOf = (b: PreviewBlock): string[] =>
      b.text.slice('[可用工具] '.length).split('。')[0]!.split('、')

    const devTools = blockOf((await preview(pid, id('dev'))).preview, 'tools')
    expect(listOf(devTools)).toEqual(devNames)
    expect(listOf(devTools)).toContain('workdir_edit')

    const pmTools = blockOf((await preview(pid, id('pm'))).preview, 'tools')
    expect(listOf(pmTools)).toContain('ask_user')
    expect(listOf(pmTools)).not.toContain('workdir_edit')
    expect(listOf(pmTools)).not.toContain('cmd_run')
    expect(pmTools.title).toContain('user 会话')
  })

  it('任务实时注入：in_progress → [当前任务]；todo → [待领取任务]', async () => {
    const { pid, id } = await setup(['dev', 'pm'])
    const dev = id('dev')
    const active = await svc.tasks.create({
      projectId: pid,
      assignee: dev,
      title: '实现登录接口',
      desc: '含边界与验收',
      creator: 'user',
    })
    await svc.tasks.setState(pid, active.task.id, 'in_progress', 'user')
    await svc.tasks.create({
      projectId: pid,
      assignee: dev,
      title: '补单测',
      desc: '',
      creator: 'user',
    })

    const p = (await preview(pid, dev)).preview
    expect(p.text).toContain(
      `[当前任务] ${active.task.id}「实现登录接口」（in_progress）：含边界与验收`,
    )
    expect(p.text).toContain('收尾三件套')
    expect(p.text).toContain('[待领取任务] 任务栏上有 1 条派给你的任务（待领取）')
    expect(p.text).toContain('「补单测」')
    // pm 手上没任务 → 两段都不出现
    const pmPreview = (await preview(pid, id('pm'))).preview
    const pmIds = pmPreview.blocks.map((b) => b.id)
    expect(pmIds).not.toContain('active-task')
    expect(pmIds).not.toContain('pending-tasks')
  })

  it('甲模式：pm 拿到 [任务栏现状] 与分派说明，dev 不拿', async () => {
    await boot({ assignByAgent: true })
    const { pid, id } = await setup(['dev', 'pm'])
    await svc.tasks.create({
      projectId: pid,
      assignee: id('dev'),
      title: '实现登录接口',
      desc: '',
      creator: id('pm'),
    })

    const pm = (await preview(pid, id('pm'))).preview
    expect(pm.blocks.map((b) => b.id)).toContain('board')
    expect(pm.text).toContain('[任务栏现状] 当前活跃任务（待领取/进行中）共 1 条')
    expect(pm.text).toContain('[任务栏（甲模式已开启）]')
    expect(pm.text).toContain('调用 task_assign')

    const dev = (await preview(pid, id('dev'))).preview
    expect(dev.blocks.map((b) => b.id)).not.toContain('board')
    expect(dev.text).not.toContain('[任务栏（甲模式已开启）]')
  })

  it('产出物归属：自己的可改、他人的只读', async () => {
    const { pid, id } = await setup(['dev', 'qa'])
    const write = async (iid: string, rel: string, text: string) => {
      const env = await buildToolEnv({ config, projectService: svc.projectService }, pid, iid, {
        sessionId: `u_${iid}`,
      })
      return executeTool(
        'workdir_edit',
        { path: `workdir://${rel}`, edits: [{ type: 'write', text }] },
        env,
      )
    }
    expect((await write(id('dev'), 'src/a.ts', 'export const a = 1\n')).ok).toBe(true)

    const dev = (await preview(pid, id('dev'))).preview
    expect(dev.text).toContain('[我的产出物（可改）]')
    expect(dev.text).toContain('- src/a.ts')

    const qa = (await preview(pid, id('qa'))).preview
    expect(qa.text).toContain('[他人产出物（只读，不可改；需要新版本请另建文件）]')
    expect(qa.text).toContain('src/a.ts —— 属 高级开发（dev_1）')
  })

  it('实例不存在 → 404', async () => {
    const { pid } = await setup(['dev'])
    const miss = await preview(pid, 'ghost_1')
    expect(miss.status).toBe(404)
    expect(miss.code).toBe('ERR_NOT_FOUND')
  })
})
