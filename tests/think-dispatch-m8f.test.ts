import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { AgentLoopRunner, type TurnContext } from '../src/application/agent-loop/loop-runner.js'
import { parseTaskIntents, dispatchTasksFromText } from '../src/application/task/task-dispatch.js'
import type { ModelGateway } from '../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

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

async function setupProject(): Promise<{ pid: string; product: TeamMemberConfig; dev: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'td', workdir, team: [{ roleTemplateId: 'product' }, { roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  const team = (p.team as TeamMemberConfig[])
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

    const evts = (await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` }))
      .json().events as Array<{ kind: string; seq: number; content?: { text?: string }; role?: string }>
    const thought = evts.find((e) => e.kind === 'thought')
    expect(thought).toBeTruthy()
    expect(thought!.content?.text).toContain('先规划再创建')
    expect(thought!.role).toBe('agent')
    const msg = evts.find((e) => e.kind === 'message' && e.role === 'agent')
    expect(thought!.seq).toBeLessThan(msg!.seq) // 思考先于正文
    expect(msg!.content?.text).toContain('结论：已收到')
  })
})

describe('任务分派（甲模式）：pm/product 回复指令 → 建任务 → 自动开工', () => {
  it('parseTaskIntents 解析围栏/无围栏 JSON 数组并校验', () => {
    const fenced = parseTaskIntents(
      '我安排如下：\n```json\n[{"assignee":"dev_1","title":"A","start":false},{"assignee":"dev_2","title":"B"}]\n```\n完毕',
    )
    expect(fenced.intents).toHaveLength(2)
    expect(fenced.intents[0]).toMatchObject({ assignee: 'dev_1', title: 'A', start: false })
    expect(fenced.intents[1]).toMatchObject({ assignee: 'dev_2', title: 'B', start: true })

    const plain = parseTaskIntents('方案通过，派活 [{"assignee":"dev_1","title":"C"}]')
    expect(plain.intents).toHaveLength(1)
    expect(plain.intents[0]!.title).toBe('C')

    const none = parseTaskIntents('只是聊天，没有分派。')
    expect(none.intents).toHaveLength(0)
  })

  it('回合内分派：任务落盘 in_progress + 系统说明追加 + 受派者自动开工', async () => {
    const { pid, product, dev } = await setupProject()
    const sid = `u_${product.instanceId}`
    const team = await svc.teamService.list(pid)

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway: fakeGatewayWith(
        '明白，登录功能我安排给开发：\n```json\n[{"assignee":"dev_1","title":"实现登录接口","desc":"含边界处理","start":true}]\n```',
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

    // 1) 任务已创建并自动开工（in_progress）
    const tasks = await svc.tasks.list(pid)
    const mine = tasks.find((t) => t.assignee === dev.instanceId && t.title.includes('登录接口'))
    expect(mine).toBeTruthy()
    expect(mine!.state).toBe('in_progress')

    // 2) 回复末尾带平台说明（诚实反馈）
    const evts = (await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` }))
      .json().events as Array<{ kind: string; role?: string; seq: number; content?: { text?: string } }>
    const agentMsg = evts.find((e) => e.kind === 'message' && e.role === 'agent')!
    expect(agentMsg.content?.text).toContain('【系统 · 任务分派】')
    expect(agentMsg.content?.text).toContain(mine!.id)
    // 审计事件
    expect(evts.filter((e) => e.kind === 'tool_call').length).toBeGreaterThan(0)
    expect(evts.filter((e) => e.kind === 'tool_result').length).toBeGreaterThan(0)
    // seq 严格递增且不重复（分派路径曾用独立 meta 追加 → 重复 seq 回归保护）
    const seqs = evts.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    // 3) 受派者自动开工：dev_1 的 user 会话收到唤醒消息并完成回合
    const devSid = `u_${dev.instanceId}`
    const deadline = Date.now() + 8000
    for (;;) {
      const log = (await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${devSid}/log` }))
        .json().events as Array<{ kind: string; role?: string; content?: { text?: string } }>
      const hasWake = log.some(
        (e) => e.kind === 'message' && e.role === 'user' && String(e.content?.text ?? '').includes('请开始执行任务'),
      )
      if (hasWake && log.some((e) => e.kind === 'turn_end')) break
      if (Date.now() > deadline) throw new Error('等待受派者开工回合超时')
      await new Promise((r) => setTimeout(r, 30))
    }
  }, 20000)

  it('start=false 或受派者忙 → 排队 todo 不自动开工', async () => {
    const { pid, product, dev } = await setupProject()
    const team = await svc.teamService.list(pid)
    // 先让 dev 忙：直接建任务并置 in_progress（user 驱动）
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
      text: '第二项排队：\n```json\n[{"assignee":"dev_1","title":"排队任务","start":true}]\n```',
      team,
      tasks: svc.tasks,
      emitTool: async () => undefined,
    })
    expect(note).toContain('排队')
    const tasks = await svc.tasks.list(pid)
    const queued = tasks.find((t) => t.title === '排队任务')
    expect(queued).toBeTruthy()
    expect(queued!.state).toBe('todo') // 槽位占用，自动保持排队
  })
})
