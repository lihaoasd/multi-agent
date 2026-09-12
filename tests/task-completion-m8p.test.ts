/**
 * 任务收尾（M8P，2026-09-12）：
 * 1) 步数用尽时仍有**收尾回合**——任务状态与用户总结不会因工具预算耗尽而丢；
 * 2) 回合末**兜底系统提示**：干了活却没上报任务状态时提醒（含"没领取就做完"的场景）；
 * 3) 完成总结（note）落库为 resultNote，随 WS task.updated 与委派人通知一起送达；
 * 4) 角色没先领取就 task_update(done) → 自动补领取后完成。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import {
  AgentLoopRunner,
  type ToolRuntimeHook,
} from '../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../src/infra/tools/executor.js'
import type { ChatMessage, ToolSchema } from '../src/infra/model/provider.js'
import type { ModelGateway } from '../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

interface Frame {
  type: string
  sessionId?: string
  payload?: Record<string, unknown>
}

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('completion-')
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

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig; product: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'completion',
      workdir,
      team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'product' }],
    },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    dev: team.find((t) => t.roleTemplateId === 'dev')!,
    product: team.find((t) => t.roleTemplateId === 'product')!,
  }
}

const toolEnv = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

/** 极简工具运行时：把可用工具透传给 executor（用于收尾/兜底用例）。 */
function runtime(pid: string, tools: ToolSchema[]): ToolRuntimeHook {
  return {
    listTools: () => tools,
    exec: async (ctx, _sessionType, name, args) =>
      executeTool(name, args, await toolEnv(pid, ctx.member.instanceId)),
    activeTask: async (ctx) => {
      const t = (await svc.tasks.list(pid, { assignee: ctx.member.instanceId, state: 'in_progress' }))[0]
      return t ? { id: t.id, title: t.title, desc: t.desc } : null
    },
    pendingTasks: async (ctx) =>
      (await svc.tasks.list(pid, { assignee: ctx.member.instanceId, state: 'todo' })).map((t) => ({
        id: t.id,
        title: t.title,
        desc: t.desc,
        creator: t.creator,
      })),
    maxSteps: 2,
  }
}

const defs = (names: string[]): ToolSchema[] =>
  listToolDefs()
    .filter((d) => names.includes(d.name))
    .map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.paramsSchema ?? { type: 'object', properties: {} },
    }))

/** 模型：前 maxSteps 步都给同一个工具调用，之后（收尾回合）给收尾动作。 */
function loom(stepCalls: Array<{ name: string; args: unknown }>, wrap: { name: string; args: unknown } | null, seen: ChatMessage[][]) {
  let i = 0
  return {
    async *streamChat(opts: { messages: ChatMessage[] }) {
      seen.push(opts.messages)
      const call = i < stepCalls.length ? stepCalls[i] : null
      i++
      if (call) {
        yield { toolCall: { index: 0, id: `c${i}`, name: call.name } }
        yield { toolCall: { index: 0, argumentsDelta: JSON.stringify(call.args) } }
        return
      }
      // 收尾回合：模型看到收尾提示后调用 wrap 工具并给总结
      const isWrap = String(opts.messages.at(-1)?.content ?? '').includes('进入**收尾**')
      if (isWrap && wrap) {
        yield { content: '已完成，下面是总结。' }
        yield { toolCall: { index: 0, id: 'cw', name: wrap.name } }
        yield { toolCall: { index: 0, argumentsDelta: JSON.stringify(wrap.args) } }
        return
      }
      yield { content: '本轮结束。' }
    },
  } as unknown as ModelGateway
}

async function sessionMessages(pid: string, sid: string) {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
  return res.json().events as Array<{
    kind: string
    role?: string
    sender?: string
    content?: { text?: string }
    payload?: Record<string, unknown>
  }>
}

describe('任务收尾：状态上报 + 完成总结', () => {
  it('步数用尽仍有收尾回合：任务置 done + resultNote + 委派人收到总结', async () => {
    const { pid, dev, product } = await setup()
    // 发布 + 领取（模拟真实流程）
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '实现登录接口' },
      await toolEnv(pid, product.instanceId),
    )
    const t = (await svc.tasks.list(pid))[0]!
    await executeTool('task_claim', { taskId: t.id }, await toolEnv(pid, dev.instanceId))

    const seen: ChatMessage[][] = []
    const gateway = loom(
      // 2 步（= maxSteps）都在写文件，耗尽预算 → 必须靠收尾回合收口
      [
        { name: 'workdir_edit', args: { path: 'workdir://src/login.ts', edits: [{ type: 'write', text: 'export const login = 1\n' }] } },
        { name: 'workdir_edit', args: { path: 'workdir://src/login.ts', edits: [{ type: 'replace', oldText: '1', newText: '2' }] } },
      ],
      { name: 'task_update', args: { state: 'done', note: '实现登录接口并自测通过，产出 src/login.ts' } },
      seen,
    )
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: runtime(pid, defs(['workdir_edit', 'task_update', 'task_claim'])),
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'wrap',
      assignableMembers: [],
    })

    // 收尾回合确实被触发（最后一条消息含收尾指令）
    expect(String(seen.at(-1)?.at(-1)?.content ?? '')).toContain('进入**收尾**')
    const after = (await svc.tasks.list(pid)).find((x) => x.id === t.id)!
    expect(after.state).toBe('done')
    expect(after.resultNote).toBe('实现登录接口并自测通过，产出 src/login.ts')

    // 委派人（product_1）收到带总结的通知
    const pmsgs = await sessionMessages(pid, `u_${product.instanceId}`)
    const noteMsg = pmsgs.find((m) => String(m.content?.text ?? '').includes('受派人总结'))
    expect(noteMsg).toBeTruthy()
    expect(String(noteMsg!.content?.text)).toContain('src/login.ts')
  }, 30000)

  it('回合末兜底：写了文件但没上报状态 → 会话出现系统提示（任务仍为进行中）', async () => {
    const { pid, dev, product } = await setup()
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '写测试报告' },
      await toolEnv(pid, product.instanceId),
    )
    const t = (await svc.tasks.list(pid))[0]!
    await executeTool('task_claim', { taskId: t.id }, await toolEnv(pid, dev.instanceId))

    const seen: ChatMessage[][] = []
    const gateway = loom(
      [
        { name: 'workdir_edit', args: { path: 'workdir://tests/report.md', edits: [{ type: 'write', text: '# 报告\n' }] } },
        { name: 'workdir_edit', args: { path: 'workdir://tests/report.md', edits: [{ type: 'write', text: '# 报告 v2\n' }] } },
      ],
      null, // 收尾回合也不上报
      seen,
    )
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: runtime(pid, defs(['workdir_edit', 'task_update'])),
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'backstop',
    })

    const evts = await sessionMessages(pid, `u_${dev.instanceId}`)
    const remind = evts.find(
      (e) => e.payload?.system === true && String(e.content?.text ?? '').includes('仍为进行中'),
    )
    expect(remind).toBeTruthy()
    expect(String(remind!.content?.text)).toContain('task_update(state=done')
    // 平台没有替角色改状态
    expect((await svc.tasks.list(pid)).find((x) => x.id === t.id)!.state).toBe('in_progress')
  }, 30000)

  it('没领取就做完：task_update(done) 自动补领取并完成 + 回执含总结', async () => {
    const { pid, dev, product } = await setup()
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '补领取场景' },
      await toolEnv(pid, product.instanceId),
    )
    const t = (await svc.tasks.list(pid))[0]!
    expect(t.state).toBe('todo')

    const res = await executeTool(
      'task_update',
      { state: 'done', note: '做完了，产出 docs/x.md' },
      await toolEnv(pid, dev.instanceId),
    )
    expect(res.ok).toBe(true)
    expect(res.ok ? res.summary : '').toContain('自动补领取')
    const after = (await svc.tasks.list(pid)).find((x) => x.id === t.id)!
    expect(after.state).toBe('done')
    expect(after.resultNote).toBe('做完了，产出 docs/x.md')
  }, 20000)

  it('WS task.updated 带 resultNote；前端 toast 用得上', async () => {
    const { pid, dev, product } = await setup()
    const frames: Frame[] = []
    const socket = await ready().injectWS(`/ws?projectId=${pid}`)
    socket.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Frame))
    try {
      await executeTool(
        'task_assign',
        { assignee: dev.instanceId, title: 'x' },
        await toolEnv(pid, product.instanceId),
      )
      const t = (await svc.tasks.list(pid))[0]!
      await executeTool('task_claim', { taskId: t.id }, await toolEnv(pid, dev.instanceId))
      await executeTool(
        'task_update',
        { state: 'done', note: '已完成并自测' },
        await toolEnv(pid, dev.instanceId),
      )
      const t0 = Date.now()
      let hit: Frame | undefined
      while (Date.now() - t0 < 4000) {
        hit = frames.find((f) => f.type === 'task.updated' && f.payload?.state === 'done')
        if (hit) break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(hit).toBeTruthy()
      expect(hit!.payload?.resultNote).toBe('已完成并自测')
    } finally {
      socket.terminate()
    }
  }, 20000)

  it('未提供 note 时回执提醒补总结（不阻塞完成）', async () => {
    const { pid, dev, product } = await setup()
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: 'y' },
      await toolEnv(pid, product.instanceId),
    )
    const t = (await svc.tasks.list(pid))[0]!
    await executeTool('task_claim', { taskId: t.id }, await toolEnv(pid, dev.instanceId))
    const res = await executeTool('task_update', { state: 'done' }, await toolEnv(pid, dev.instanceId))
    expect(res.ok).toBe(true)
    expect(res.ok ? res.summary : '').toContain('未提供完成总结')
  }, 20000)
})
