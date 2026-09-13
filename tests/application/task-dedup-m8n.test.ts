/**
 * 任务撞车去重（M8N，2026-09-12）：pm / product 同时派同一件事时只保留一条任务。
 * 覆盖：同题同受派人去重（工具入口 / HTTP 入口 / 文本入口）、标题归一化、不同受派人允许、
 * force 逃生阀、终态后可再派、并发发布不丢写、[任务栏现状] 共享视野注入。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { AgentLoopRunner, type TurnContext } from '../../src/application/agent-loop/loop-runner.js'
import { dispatchTasksFromText, parseTaskIntents } from '../../src/application/task/task-dispatch.js'
import { executeTool } from '../../src/infra/tools/executor.js'
import type { ChatMessage } from '../../src/infra/model/provider.js'
import type { ModelGateway } from '../../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('dedup-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data'), task: { assignByAgent: true } }, base)
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

async function setup(): Promise<{
  pid: string
  dev: TeamMemberConfig
  qa: TeamMemberConfig
  pm: TeamMemberConfig
  product: TeamMemberConfig
}> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'dedup',
      workdir,
      team: [
        { roleTemplateId: 'dev' },
        { roleTemplateId: 'qa' },
        { roleTemplateId: 'pm' },
        { roleTemplateId: 'product' },
      ],
    },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  const pick = (r: string) => team.find((t) => t.roleTemplateId === r)!
  return { pid: p.id, dev: pick('dev'), qa: pick('qa'), pm: pick('pm'), product: pick('product') }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

describe('任务撞车去重（两位管理者同时派同一件事）', () => {
  it('同题同受派人：pm 先发、product 再发 → 只保留一条，回执说明与谁重复', async () => {
    const { pid, dev, pm, product } = await setup()
    const first = await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '实现贪吃蛇核心玩法', desc: '移动/吃食/碰撞' },
      await env(pid, pm.instanceId),
    )
    expect(first.ok).toBe(true)
    expect(first.ok ? first.summary : '').toContain('已发布任务')

    const second = await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '实现贪吃蛇核心玩法', desc: '我来补一句：含计分' },
      await env(pid, product.instanceId),
    )
    expect(second.ok).toBe(true)
    const summary = second.ok ? second.summary : ''
    expect(summary).toContain('未重复创建')
    expect(summary).toContain(pm.instanceId) // 回执点名了先发布的人
    expect(summary).toContain('force=true')

    const tasks = await svc.tasks.list(pid)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.creator).toBe(pm.instanceId)
  }, 20000)

  it('标题归一化：空格/标点/大小写差异视为同题；不同受派人允许各自一条', async () => {
    const { pid, dev, qa, pm, product } = await setup()
    await svc.tasks.create({
      projectId: pid,
      title: 'Fix Login Bug!',
      creator: pm.instanceId,
      assignee: dev.instanceId,
    })
    // 归一化后同名（去空白/标点 + 小写）→ 去重
    const dup = await svc.tasks.create({
      projectId: pid,
      title: ' fix  login   bug ',
      creator: product.instanceId,
      assignee: dev.instanceId,
    })
    expect(dup.duplicate).toBe(true)
    // 同标题但不同受派人 → 各留一条（不是重复劳动，是不同人的活）
    const other = await svc.tasks.create({
      projectId: pid,
      title: 'Fix Login Bug!',
      creator: product.instanceId,
      assignee: qa.instanceId,
    })
    expect(other.duplicate).toBe(false)
    expect(await svc.tasks.list(pid)).toHaveLength(2)
  }, 20000)

  it('force=true 强制重复发布；任务终态后同题可再派', async () => {
    const { pid, dev, pm, product } = await setup()
    const a = await svc.tasks.create({
      projectId: pid,
      title: '回归测试',
      creator: pm.instanceId,
      assignee: dev.instanceId,
    })
    const forced = await svc.tasks.create(
      { projectId: pid, title: '回归测试', creator: product.instanceId, assignee: dev.instanceId },
      { force: true },
    )
    expect(forced.duplicate).toBe(false)
    expect(forced.task.id).not.toBe(a.task.id)

    // 终态不参与去重：做完可以再派一轮
    await svc.tasks.setState(pid, a.task.id, 'in_progress', dev.instanceId)
    await svc.tasks.setState(pid, a.task.id, 'done', dev.instanceId)
    await svc.tasks.claim(pid, dev.instanceId, forced.task.id)
    await svc.tasks.setState(pid, forced.task.id, 'terminated', 'user')
    const again = await svc.tasks.create({
      projectId: pid,
      title: '回归测试',
      creator: pm.instanceId,
      assignee: dev.instanceId,
    })
    expect(again.duplicate).toBe(false)
  }, 20000)

  it('并发发布：两位管理者同时发不同任务 → 两条都在（读改写有锁，不丢任务）', async () => {
    const { pid, dev, pm, product } = await setup()
    const results = await Promise.all([
      svc.tasks.create({
        projectId: pid,
        title: '任务甲',
        creator: pm.instanceId,
        assignee: dev.instanceId,
      }),
      svc.tasks.create({
        projectId: pid,
        title: '任务乙',
        creator: product.instanceId,
        assignee: dev.instanceId,
      }),
    ])
    expect(results.every((r) => !r.duplicate)).toBe(true)
    const tasks = await svc.tasks.list(pid)
    expect(tasks.map((t) => t.title).sort()).toEqual(['任务乙', '任务甲'])
  }, 20000)

  it('并发发同题：只创建一条（去重检查在锁内）', async () => {
    const { pid, dev, pm, product } = await setup()
    const results = await Promise.all([
      svc.tasks.create({
        projectId: pid,
        title: '同一件事',
        creator: pm.instanceId,
        assignee: dev.instanceId,
      }),
      svc.tasks.create({
        projectId: pid,
        title: '同一件事',
        creator: product.instanceId,
        assignee: dev.instanceId,
      }),
    ])
    expect(results.filter((r) => r.duplicate)).toHaveLength(1)
    expect(await svc.tasks.list(pid)).toHaveLength(1)
  }, 20000)

  it('文本入口（回复 JSON）：重复发布时给出"未重复创建"回执', async () => {
    const { pid, pm, product } = await setup()
    const team = await svc.teamService.list(pid)
    const run = (actor: TeamMemberConfig, text: string) =>
      dispatchTasksFromText({
        projectId: pid,
        sessionId: `u_${actor.instanceId}`,
        actorId: actor.instanceId,
        actorName: actor.displayName,
        text,
        team,
        tasks: svc.tasks,
        emitTool: async () => undefined,
      })
    const first = await run(pm, '[{"assignee":"dev_1","title":"实现登录接口"}]')
    expect(first).toContain('已发布到任务栏')
    const second = await run(product, '再贴一次：[{"assignee":"dev_1","title":"实现登录接口"}]')
    expect(second).toContain('本次未重复创建')
    expect(await svc.tasks.list(pid)).toHaveLength(1)
    // JSON 里的 force 逃生阀
    const intents = parseTaskIntents('[{"assignee":"dev_1","title":"x","force":true}]')
    expect(intents.intents[0]!.force).toBe(true)
    const forced = await run(product, '[{"assignee":"dev_1","title":"实现登录接口","force":true}]')
    expect(forced).toContain('已发布到任务栏')
    expect(await svc.tasks.list(pid)).toHaveLength(2)
  }, 20000)

  it('HTTP 入口：重复发布返回 200 + duplicate=true（新建为 201）', async () => {
    const { pid, dev } = await setup()
    const body = { title: '写部署手册', assignee: dev.instanceId, creator: 'user' }
    const first = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: body,
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().duplicate).toBe(false)
    const second = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: body,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().duplicate).toBe(true)
    expect(second.json().task.id).toBe(first.json().task.id)
  }, 20000)

  it('共享视野：pm/product 的系统提示注入 [任务栏现状]（含别人发布的任务）', async () => {
    const { pid, dev, pm, product } = await setup()
    await svc.tasks.create({
      projectId: pid,
      title: '实现贪吃蛇核心玩法',
      creator: pm.instanceId,
      assignee: dev.instanceId,
    })
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
        boardTasks: async () =>
          (await svc.tasks.list(pid))
            .filter((t) => t.state === 'todo' || t.state === 'in_progress')
            .map((t) => ({
              id: t.id,
              title: t.title,
              assignee: t.assignee,
              creator: t.creator,
              state: t.state === 'todo' ? '待领取' : '进行中',
            })),
      },
      taskDispatch: { run: async () => '' },
    })
    const team = await svc.teamService.list(pid)
    const ctx: TurnContext = {
      projectId: pid,
      sessionId: `u_${product.instanceId}`,
      member: product,
      scenario: 'board',
      assignableMembers: team
        .filter((m) => m.enabled)
        .map((m) => ({ instanceId: m.instanceId, displayName: m.displayName })),
    }
    await loop.runDirectTurn(ctx)
    const system = String(seen[0]?.[0]?.content ?? '')
    expect(system).toContain('[任务栏现状]')
    expect(system).toContain('实现贪吃蛇核心玩法')
    expect(system).toContain(pm.instanceId)
    expect(system).toContain('不要重复发布')

    // 受派人（dev）不注入 [任务栏现状]（那是管理者视野）
    seen.length = 0
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'board',
    })
    expect(String(seen[0]?.[0]?.content ?? '')).not.toContain('[任务栏现状]')
  }, 20000)
})
