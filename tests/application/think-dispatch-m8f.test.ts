import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { AgentLoopRunner, type TurnContext } from '../../src/application/agent-loop/loop-runner.js'
import { parseTaskIntents, dispatchTasksFromText } from '../../src/application/task/task-dispatch.js'
import { executeTool, listToolDefs } from '../../src/infra/tools/executor.js'
import type { ModelGateway } from '../../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>

beforeEach(async () => {
  base = await makeTempDir('think-dispatch-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data'), task: { assignByAgent: true } }, base)
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

async function setupProject(): Promise<{
  pid: string
  product: TeamMemberConfig
  dev: TeamMemberConfig
}> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'td',
      workdir,
      team: [{ roleTemplateId: 'product' }, { roleTemplateId: 'dev' }],
    },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  const product = team.find((t) => t.roleTemplateId === 'product')!
  const dev = team.find((t) => t.roleTemplateId === 'dev')!
  return { pid: p.id, product, dev }
}

/** 假网关：推理先行、正文携带任务分派指令。 */
function fakeGatewayWith(text: string): ModelGateway {
  return {
    async *streamChat() {
      yield { reasoning: '老板要求分派任务。先规划再创建并指派，然后汇报结果。' }
      yield { content: text }
    },
  } as unknown as ModelGateway
}

describe('think 展示：reasoning → thought 事件 + thought.chunk 推送', () => {
  it('模型推理增量落 thought 事件（先于 message），thought.chunk 推送前端', async () => {
    const { pid, product } = await setupProject()
    const sid = `u_${product.instanceId}`

    const chunks: string[] = []
    const off = svc.bus.subscribe({
      projectId: pid,
      sessionId: sid,
      onEvent: (e) => {
        if (e.type === 'thought.chunk') chunks.push(String(e.payload?.delta ?? ''))
      },
    })

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway: fakeGatewayWith('结论：已收到。'),
      bus: svc.bus,
      occupancy: svc.occupancy,
    })
    const ctx: TurnContext = {
      projectId: pid,
      sessionId: sid,
      member: product,
      scenario: 'think-demo',
    }
    await loop.runDirectTurn(ctx)
    off()

    // 推送前端：思考增量可流式展示
    expect(chunks.join('')).toContain('先规划再创建')

    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    ).json().events as Array<{
      kind: string
      seq: number
      content?: { text?: string }
      role?: string
    }>
    const thought = evts.find((e) => e.kind === 'thought')
    expect(thought).toBeTruthy()
    expect(thought!.content?.text).toContain('先规划再创建')
    expect(thought!.role).toBe('agent')
    const msg = evts.find((e) => e.kind === 'message' && e.role === 'agent')
    expect(thought!.seq).toBeLessThan(msg!.seq) // 思考先于正文
    expect(msg!.content?.text).toContain('结论：已收到')
  })
})

describe('任务分派（甲模式）：pm/product 发布任务到任务栏 → 通知领取', () => {
  it('parseTaskIntents 解析围栏/无围栏 JSON 数组并校验', () => {
    const fenced = parseTaskIntents(
      '我安排如下：\n```json\n[{"assignee":"dev_1","title":"A","desc":"甲"},{"assignee":"dev_2","title":"B"}]\n```\n完毕',
    )
    expect(fenced.intents).toHaveLength(2)
    expect(fenced.intents[0]).toMatchObject({ assignee: 'dev_1', title: 'A', desc: '甲' })
    expect(fenced.intents[1]).toMatchObject({ assignee: 'dev_2', title: 'B' })
    // 兼容旧协议字段 start：解析时忽略（不再有"立即开工"语义）
    expect(parseTaskIntents('[{"assignee":"dev_1","title":"A","start":false}]').intents[0]).toEqual({
      assignee: 'dev_1',
      title: 'A',
      desc: undefined,
      force: false,
    })

    const plain = parseTaskIntents('方案通过，派活 [{"assignee":"dev_1","title":"C"}]')
    expect(plain.intents).toHaveLength(1)
    expect(plain.intents[0]!.title).toBe('C')

    const none = parseTaskIntents('只是聊天，没有分派。')
    expect(none.intents).toHaveLength(0)
  })

  it('解析容错：围栏内多余引号/无围栏/多数组去重/无关数组不误判', () => {
    // 真实失败样例：```json 围栏内 JSON 末尾多了一个引号（PM 派单没生效的原因）
    const strayQuote =
      '现在派单 👇\n\n```json\n[{"assignee":"product_1","title":"范围清单","desc":"含边界"}]\n"\n```\n\n我在等产出。'
    const r1 = parseTaskIntents(strayQuote)
    expect(r1.intents).toHaveLength(1)
    expect(r1.intents[0]).toMatchObject({ assignee: 'product_1', title: '范围清单' })

    // 同一数组既在围栏里、又被复述一遍 → 去重
    const dup =
      '```json\n[{"assignee":"dev_1","title":"A"}]\n```\n再贴一次：\n[{"assignee":"dev_1","title":"A"}]'
    expect(parseTaskIntents(dup).intents).toHaveLength(1)

    // 两个独立的数组都能取到
    const two =
      '第一波：[{"assignee":"dev_1","title":"A"}]\n第二波：[{"assignee":"qa_1","title":"B"}]'
    expect(parseTaskIntents(two).intents.map((i) => i.assignee)).toEqual(['dev_1', 'qa_1'])

    // markdown 链接等无关方括号不误判
    const noise = '见 [文档](https://x.dev) 与 ["a","b"] 以及 [1,2,3]'
    expect(parseTaskIntents(noise).intents).toHaveLength(0)
  })

  it('看起来要派单但 JSON 解析不了 → 明确回执且不创建任务（不再静默失败）', async () => {
    const { pid, product } = await setupProject()
    const team = await svc.teamService.list(pid)
    const note = await dispatchTasksFromText({
      projectId: pid,
      sessionId: `u_${product.instanceId}`,
      actorId: product.instanceId,
      actorName: product.displayName,
      text: '现在派单：assignee 我写成这样了 [{assignee: product_1, title: 范围}]，你看行吗',
      team,
      tasks: svc.tasks,
      emitTool: async () => undefined,
    })
    expect(note).toContain('未识别到有效的分派指令')
    expect(note).toContain('未创建任何任务')
    expect(note).toContain('task_assign')
    expect(await svc.tasks.list(pid)).toHaveLength(0)
  })

  it('推荐路径：task_assign 工具发布 → 任务栏 todo（待领取）+ 回执说明', async () => {
    const { pid, product, dev } = await setupProject()
    const sid = `u_${product.instanceId}`
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        if (call === 1) {
          yield {
            toolCall: {
              index: 0,
              id: 'call_assign',
              name: 'task_assign',
              argumentsDelta: JSON.stringify({
                assignee: dev.instanceId,
                title: '实现贪吃蛇核心玩法',
                desc: '移动/吃食/碰撞/计分/重开',
              }),
            },
          }
          return
        }
        yield { content: '已发布到任务栏。' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: {
        listTools: (ctx, sessionType) => {
          const allowed = new Set(ctx.member.tools ?? [])
          return listToolDefs()
            .filter(
              (d) =>
                d.availableIn.includes(sessionType) &&
                (allowed.has(d.name) || (sessionType === 'user' && d.name === 'task_assign')),
            )
            .map((d) => ({
              name: d.name,
              description: d.description,
              parameters: d.paramsSchema ?? { type: 'object', properties: {} },
            }))
        },
        exec: async (ctx, sessionType, name, args) =>
          executeTool(
            name,
            args,
            await buildToolEnv(
              { config: svc.config, projectService: svc.projectService },
              ctx.projectId,
              ctx.member.instanceId,
              {
                sessionId: ctx.sessionId,
                sessionType: sessionType === 'meeting' ? 'meeting' : 'user',
              },
            ),
          ),
        maxSteps: 3,
      },
    })
    await loop.runDirectTurn({ projectId: pid, sessionId: sid, member: product, scenario: 'td' })

    const tasks = await svc.tasks.list(pid)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.assignee).toBe(dev.instanceId)
    expect(tasks[0]!.title).toBe('实现贪吃蛇核心玩法')
    expect(tasks[0]!.state).toBe('todo') // 发布到任务栏：待领取（等 dev 自己 claim）
    expect(tasks[0]!.creator).toBe(product.instanceId)
  })

  it('回合内发布：任务落盘 todo（待领取）+ 系统说明追加 + 通知受派人领取', async () => {
    const { pid, product, dev } = await setupProject()
    const sid = `u_${product.instanceId}`
    const team = await svc.teamService.list(pid)

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway: fakeGatewayWith(
        '明白，登录功能我发布到任务栏：\n```json\n[{"assignee":"dev_1","title":"实现登录接口","desc":"含边界处理"}]\n```',
      ),
      bus: svc.bus,
      occupancy: svc.occupancy,
      taskDispatch: {
        run: async (ctx, text) =>
          dispatchTasksFromText({
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            actorId: ctx.member.instanceId,
            actorName: ctx.member.displayName,
            text,
            team,
            tasks: svc.tasks,
            emitTool: async (kind, payload) => {
              const meta = await svc.sessionStore.tryReadMeta(ctx.projectId, ctx.sessionId)
              if (!meta) return
              const evt = await svc.sessionStore.appendEvent(meta, {
                kind,
                sender: ctx.member.instanceId,
                role: 'agent',
                payload,
              })
              svc.bus.emitLogEvent(ctx.projectId, evt)
            },
          }),
      },
    })
    const ctx: TurnContext = {
      projectId: pid,
      sessionId: sid,
      member: product,
      scenario: 'dispatch-demo',
      assignableMembers: team
        .filter((m) => m.enabled)
        .map((m) => ({ instanceId: m.instanceId, displayName: m.displayName })),
    }
    await loop.runDirectTurn(ctx)

    // 1) 任务已发布到任务栏（todo 待领取）
    const tasks = await svc.tasks.list(pid)
    const mine = tasks.find((t) => t.assignee === dev.instanceId && t.title.includes('登录接口'))
    expect(mine).toBeTruthy()
    expect(mine!.state).toBe('todo')

    // 2) 回复末尾带平台说明（诚实反馈）
    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    ).json().events as Array<{
      kind: string
      role?: string
      seq: number
      content?: { text?: string }
    }>
    const agentMsg = evts.find((e) => e.kind === 'message' && e.role === 'agent')!
    expect(agentMsg.content?.text).toContain('【系统 · 任务栏】')
    expect(agentMsg.content?.text).toContain(mine!.id)
    // 审计事件
    expect(evts.filter((e) => e.kind === 'tool_call').length).toBeGreaterThan(0)
    expect(evts.filter((e) => e.kind === 'tool_result').length).toBeGreaterThan(0)
    // seq 严格递增且不重复（分派路径曾用独立 meta 追加 → 重复 seq 回归保护）
    const seqs = evts.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    // 3) 受派人收到"待领取"通知：dev_1 的 user 会话出现系统消息并完成回合
    const devSid = `u_${dev.instanceId}`
    const deadline = Date.now() + 8000
    for (;;) {
      const log = (
        await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${devSid}/log` })
      ).json().events as Array<{ kind: string; role?: string; content?: { text?: string } }>
      const hasWake = log.some(
        (e) =>
          e.kind === 'message' &&
          e.role === 'user' &&
          String(e.content?.text ?? '').includes('任务栏有任务待你领取'),
      )
      if (hasWake && log.some((e) => e.kind === 'turn_end')) break
      if (Date.now() > deadline) throw new Error('等待受派人领取通知超时')
      await new Promise((r) => setTimeout(r, 30))
    }
  }, 20000)

  it('发布后保持待领取；受派人槽位被占时领取被拒（claim）', async () => {
    const { pid, product, dev } = await setupProject()
    const team = await svc.teamService.list(pid)
    // 先让 dev 忙：建任务并置 in_progress（user 驱动）
    const first = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '已有任务', assignee: dev.instanceId, creator: 'user' },
    })
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${first.json().task.id}`,
      payload: { state: 'in_progress', actor: 'user' },
    })

    const note = await dispatchTasksFromText({
      projectId: pid,
      sessionId: `u_${product.instanceId}`,
      actorId: product.instanceId,
      actorName: product.displayName,
      text: '第二项发布：\n```json\n[{"assignee":"dev_1","title":"排队任务"}]\n```',
      team,
      tasks: svc.tasks,
      emitTool: async () => undefined,
    })
    expect(note).toContain('已发布到任务栏')
    const tasks = await svc.tasks.list(pid)
    const queued = tasks.find((t) => t.title === '排队任务')
    expect(queued).toBeTruthy()
    expect(queued!.state).toBe('todo') // 待领取
    // dev 手上有进行中任务 → 领取被拒（不静默开工）
    await expect(svc.tasks.claim(pid, dev.instanceId, queued!.id)).rejects.toThrow(/已有进行中任务/)
    // 非受派人不能领取
    await expect(svc.tasks.claim(pid, product.instanceId, queued!.id)).rejects.toThrow(/不能领取/)
  })
})

describe('think 与助手回复是两路（分离保证）', () => {
  it('思考只进 thought 事件，不进正文、不回灌后续上下文', async () => {
    const { pid, product } = await setupProject()
    const sid = `u_${product.instanceId}`
    const calls: Array<Array<{ role: string; content: string }>> = []
    const gateway = {
      async *streamChat(opts: { messages: Array<{ role: string; content: string }> }) {
        calls.push(opts.messages)
        yield { reasoning: '内部推理MARKER：先想清楚再答。' }
        yield { content: '给用户的答复MARKER' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    const ctx: TurnContext = { projectId: pid, sessionId: sid, member: product, scenario: 'sep' }
    await loop.runDirectTurn(ctx)

    // 第二轮：先补一条用户消息，再看第二轮发给模型的上下文
    const meta = await svc.sessionStore.readMeta(pid, sid)
    await svc.sessionStore.appendEvent(meta, {
      kind: 'message',
      role: 'user',
      sender: 'user',
      content: { text: '继续', blocks: [] },
    })
    await loop.runDirectTurn(ctx)

    const second = JSON.stringify(calls[1] ?? [])
    expect(second).not.toContain('内部推理MARKER') // 思考不回灌上下文
    expect(second).toContain('给用户的答复MARKER') // 上一轮正文作为历史
    // 正文里也不含思考标记
    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    ).json().events as Array<{ kind: string; role?: string; content?: { text?: string } }>
    const msgs = evts.filter((e) => e.kind === 'message' && e.role === 'agent')
    expect(msgs).toHaveLength(2)
    for (const m of msgs) expect(m.content?.text ?? '').not.toContain('内部推理MARKER')
    expect(evts.filter((e) => e.kind === 'thought')).toHaveLength(2)
  })

  it('只出思考不出正文时给出平台提示（不留空气泡）', async () => {
    const { pid, product } = await setupProject()
    const sid = `u_${product.instanceId}`
    const gateway = {
      async *streamChat() {
        yield { reasoning: '想到了很多，但预算用尽。' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    const evt = await loop.runDirectTurn({
      projectId: pid,
      sessionId: sid,
      member: product,
      scenario: 'reasoning-only',
    })
    expect(evt.content?.text ?? '').toContain('只给出了思考过程')
    expect(evt.content?.text ?? '').not.toContain('预算用尽')
  })
})
