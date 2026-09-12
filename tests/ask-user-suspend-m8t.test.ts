/**
 * ask_user 的挂起语义与推送时序（M8T，2026-09-12）。
 *
 * 用户反馈：提问应该"等用户决策"，不应该还在执行任务；而且卡片弹出时角色状态还没变、
 * 甚至角色还在思考就弹了卡片；前端轮询接口还会返回空数组多次调用。
 *
 * 现在的语义：
 *  1) `ask_user` 成功 → **本回合立即结束**（不再调用任何工具、不执行任务）；
 *  2) 提问事件**延迟到回合结束、占用释放之后**再广播（卡片出现时角色已是「等待你处理」）；
 *  3) 挂起期间不催任务状态（任务是暂停，不是完成）；
 *  4) 前端不再轮询 `/questions?status=pending`（只有打开会话/重连时拉一次兜底）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { AgentLoopRunner } from '../src/application/agent-loop/loop-runner.js'
import type { ChatMessage, ToolSchema } from '../src/infra/model/provider.js'
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
  base = await makeTempDir('suspend-')
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

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'suspend', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

describe('ask_user：挂起等待用户决策 + 推送时序', () => {
  it('提问后本回合立即结束：模型只被调用一次，不再继续执行任务', async () => {
    const { pid, dev } = await setup()
    const seen: ChatMessage[][] = []
    let calls = 0
    const gateway = {
      async *streamChat(opts: { messages: ChatMessage[] }) {
        seen.push(opts.messages)
        calls++
        // 第 1 轮：先问用户；如果平台不挂起，模型下一轮会继续写文件
        if (calls === 1) {
          yield { content: '这里需要你拍板。' }
          yield { toolCall: { index: 0, id: 'q1', name: 'ask_user' } }
          yield {
            toolCall: {
              index: 0,
              argumentsDelta: JSON.stringify({ question: '要 A 还是 B？', kind: 'single', options: ['A', 'B'] }),
            },
          }
          return
        }
        yield { toolCall: { index: 0, id: `c${calls}`, name: 'workdir_edit' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({
              path: `workdir://notes/after-ask-${calls}.md`,
              edits: [{ type: 'write', text: '不该继续写\n' }],
            }),
          },
        }
      },
    } as unknown as ModelGateway

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () =>
          [
            { name: 'ask_user' },
            { name: 'workdir_edit' },
          ] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) =>
          (await import('../src/infra/tools/executor.js')).executeTool(
            name,
            args,
            await (await import('../src/application/composition.js')).buildToolEnv(
              { config, projectService: svc.projectService },
              ctx.projectId,
              ctx.member.instanceId,
              { sessionId: ctx.sessionId },
            ),
          ),
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'ask-suspend',
    })

    // 只调用一次模型：提问后立即挂起，没有再执行第二轮（也不会跑收尾回合）
    expect(calls).toBe(1)
    // 没有写任何文件
    const fsMod = await import('node:fs/promises')
    const notes = await fsMod.readdir(join(workdir, 'notes')).catch(() => [])
    expect(notes).toEqual([])
    // 提问已落盘
    const pending = await svc.questions.list(pid, { status: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.question).toBe('要 A 还是 B？')
  }, 30000)

  it('推送时序：question.asked 出现在回合结束（turn_end）之后，且那一刻状态是「等待你处理」', async () => {
    const { pid, dev } = await setup()
    const order: string[] = []
    const off = svc.bus.subscribe({
      projectId: pid,
      onEvent: (e) => {
        if (e.type === 'question.asked') order.push('question.asked')
        if (e.type === 'event.appended' && (e.payload as { kind?: string })?.kind === 'turn_end') {
          order.push('turn_end')
        }
      },
    })
    let calls = 0
    const gateway = {
      async *streamChat() {
        calls++
        yield { content: '需要你确认。' }
        yield { toolCall: { index: 0, id: 'q1', name: 'ask_user' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({ question: '确认继续？', kind: 'confirm' }),
          },
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () => [{ name: 'ask_user' }] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) =>
          (await import('../src/infra/tools/executor.js')).executeTool(
            name,
            args,
            await (await import('../src/application/composition.js')).buildToolEnv(
              { config, projectService: svc.projectService },
              ctx.projectId,
              ctx.member.instanceId,
              { sessionId: ctx.sessionId },
            ),
          ),
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'order',
    })
    off()

    expect(calls).toBe(1)
    expect(order).toContain('turn_end')
    expect(order).toContain('question.asked')
    // 关键：提问推送在 turn_end **之后**（之前会出现"角色还在思考/执行，卡片已弹出"）
    expect(order.indexOf('question.asked')).toBeGreaterThan(order.indexOf('turn_end'))

    // 此刻（占用已释放 + 有待答提问）状态应为 waiting，而不是 working
    const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    const me = (res.json().agents as Array<{ instanceId: string; state: string }>).find(
      (a) => a.instanceId === dev.instanceId,
    )
    expect(me!.state).toBe('waiting')
  }, 30000)

  it('同一步并发多个 ask_user：只执行第一个，其余直接跳过（不再出现失败行）', async () => {
    const { pid, dev } = await setup()
    let calls = 0
    const gateway = {
      async *streamChat() {
        calls++
        yield { content: '有三个点要你拍板。' }
        // 真实案例：模型在一个 step 里并发给了 3 个 ask_user
        for (const [i, q] of [
          { question: '目标平台选哪个？', kind: 'single', options: ['A', 'B'] },
          { question: '功能范围选哪些？', kind: 'multi', options: ['x', 'y'] },
          { question: '技术栈有偏好吗？', kind: 'single', options: ['p', 'q'] },
        ].entries()) {
          yield { toolCall: { index: i, id: `q${i}`, name: 'ask_user' } }
          yield { toolCall: { index: i, argumentsDelta: JSON.stringify(q) } }
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () => [{ name: 'ask_user' }] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) =>
          (await import('../src/infra/tools/executor.js')).executeTool(
            name,
            args,
            await (await import('../src/application/composition.js')).buildToolEnv(
              { config, projectService: svc.projectService },
              ctx.projectId,
              ctx.member.instanceId,
              { sessionId: ctx.sessionId },
            ),
          ),
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'multi-ask',
    })
    expect(calls).toBe(1)
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const evts = res.json().events as Array<{ kind: string; payload?: Record<string, unknown> }>
    const askCalls = evts.filter((e) => e.kind === 'tool_call' && e.payload?.tool === 'ask_user')
    const askResults = evts.filter((e) => e.kind === 'tool_result' && e.payload?.tool === 'ask_user')
    // 只执行第一个：一次调用、一条结果、且成功（没有 ERR_CONFLICT 噪声）
    expect(askCalls).toHaveLength(1)
    expect(askResults).toHaveLength(1)
    expect(askResults[0]!.payload?.ok).toBe(true)
    // 只落一条待答提问
    expect(await svc.questions.list(pid, { status: 'pending' })).toHaveLength(1)
  }, 30000)

  it('已有待答提问时再次提问 → 软挂起（ok+suspend），不报错、不再执行任务', async () => {
    const { pid, dev } = await setup()
    // 先造一个待答提问（模拟上一轮问过、用户还没回答）
    await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      question: '上一轮的问题还在等你回答',
      kind: 'confirm',
    })
    let calls = 0
    const gateway = {
      async *streamChat() {
        calls++
        yield { toolCall: { index: 0, id: 'q1', name: 'ask_user' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({ question: '另一个问题？', kind: 'text' }),
          },
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () => [{ name: 'ask_user' }] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) =>
          (await import('../src/infra/tools/executor.js')).executeTool(
            name,
            args,
            await (await import('../src/application/composition.js')).buildToolEnv(
              { config, projectService: svc.projectService },
              ctx.projectId,
              ctx.member.instanceId,
              { sessionId: ctx.sessionId },
            ),
          ),
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'dup-ask',
    })
    expect(calls).toBe(1) // 软挂起：不再继续执行
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const evts = res.json().events as Array<{
      kind: string
      payload?: Record<string, unknown>
      content?: { text?: string }
    }>
    const result = evts.find((e) => e.kind === 'tool_result' && e.payload?.tool === 'ask_user')
    expect(result!.payload?.ok).toBe(true) // 关键：不再是 ERR_CONFLICT
    expect(String(result!.payload?.summary ?? '')).toContain('已有待回答的提问')
    expect(await svc.questions.list(pid, { status: 'pending' })).toHaveLength(1) // 没多建
  }, 30000)

  it('挂起时不催任务状态（任务是暂停，不是完成）', async () => {
    const { pid, dev } = await setup()
    const { executeTool } = await import('../src/infra/tools/executor.js')
    const { buildToolEnv } = await import('../src/application/composition.js')
    const envOf = async () =>
      buildToolEnv({ config, projectService: svc.projectService }, pid, dev.instanceId, {
        sessionId: `u_${dev.instanceId}`,
      })
    // 造一条进行中的任务
    await svc.tasks.create({
      projectId: pid,
      title: '待用户决策的任务',
      creator: 'user',
      assignee: dev.instanceId,
    })
    const t = (await svc.tasks.list(pid))[0]!
    await executeTool('task_claim', { taskId: t.id }, await envOf())

    let calls = 0
    const gateway = {
      async *streamChat() {
        calls++
        yield { toolCall: { index: 0, id: 'q1', name: 'ask_user' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({ question: '这个规则按 A 还是 B？', kind: 'text' }),
          },
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () => [{ name: 'ask_user' }] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) =>
          executeTool(name, args, await envOf()),
        activeTask: async (ctx) => {
          const list = await svc.tasks.list(ctx.projectId, {
            assignee: ctx.member.instanceId,
            state: 'in_progress',
          })
          const x = list[0]
          return x ? { id: x.id, title: x.title, desc: x.desc } : null
        },
        pendingTasks: async () => [],
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'no-nag',
    })
    expect(calls).toBe(1) // 没有因为"没收尾"而再跑一轮
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const evts = res.json().events as Array<{ payload?: Record<string, unknown>; content?: { text?: string } }>
    // 不应出现"任务仍为进行中，请 task_update"的催促
    expect(evts.some((e) => String(e.content?.text ?? '').includes('仍为进行中'))).toBe(false)
    // 任务保持进行中（暂停，不是被平台改状态）
    expect((await svc.tasks.list(pid)).find((x) => x.id === t.id)!.state).toBe('in_progress')
  }, 30000)
})
