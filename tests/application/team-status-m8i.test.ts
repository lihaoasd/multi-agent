import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { AgentLoopRunner, type TurnContext } from '../../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../../src/infra/tools/executor.js'
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
  base = await makeTempDir('team-status-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  // 默认关掉会议自动开始/自动收尾：本文件多数用例断言"手动推进"的中间态（proposed/open/占用/点名）；
  // 需要验证"平台自动开场"的用例传 autoStart: true（见两个 meeting_start 用例）。
  await boot()
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

/** 装配服务 + app（可覆盖会议自动开始/收尾；同一个用例多次调用会重建服务）。 */
async function boot(opts: { autoStart?: boolean; autoClose?: boolean } = {}): Promise<void> {
  config.meeting = {
    autoStart: opts.autoStart ?? false,
    autoClose: opts.autoClose ?? false,
  }
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
    payload: { name: 'ts', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    team,
    id: (r: string) => team.find((t) => t.roleTemplateId === r)!.instanceId,
  }
}

async function agents(
  pid: string,
): Promise<Array<{ instanceId: string; state: string; currentTask?: { title: string } | null }>> {
  const d = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
  return d.json().agents
}

/** 真实注册表派生的工具运行时（含平台工具白名单规则，与 composition 一致）。 */
function toolRuntime(
  activeTask?: (ctx: TurnContext) => Promise<{ id: string; title: string; desc: string } | null>,
) {
  return {
    listTools: (ctx: TurnContext, sessionType: string) => {
      const allowed = new Set(ctx.member.tools ?? [])
      const platform = new Set(['ask_user', 'task_assign', 'task_update'])
      return listToolDefs()
        .filter(
          (d) =>
            d.availableIn.includes(sessionType) &&
            (allowed.has(d.name) || (sessionType === 'user' && platform.has(d.name))),
        )
        .map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.paramsSchema ?? { type: 'object', properties: {} },
        }))
    },
    exec: async (
      ctx: TurnContext,
      sessionType: string,
      name: string,
      args: Record<string, unknown>,
    ) =>
      executeTool(
        name,
        args,
        await buildToolEnv(
          { config, projectService: svc.projectService },
          ctx.projectId,
          ctx.member.instanceId,
          {
            sessionId: ctx.sessionId,
            taskId: (await activeTask?.(ctx))?.id,
            sessionType: sessionType === 'meeting' ? 'meeting' : 'user',
          },
        ),
      ),
    activeTask,
    maxSteps: 4,
  }
}

/** 脚本化网关：按调用次序回放；每步可含 toolCall 或 content。 */
function scripted(steps: Array<Array<Record<string, unknown>>>): ModelGateway {
  let i = 0
  return {
    async *streamChat() {
      const step = steps[Math.min(i, steps.length - 1)] ?? []
      i++
      for (const item of step) yield item
    },
  } as unknown as ModelGateway
}

describe('团队状态（GET /agents）', () => {
  it('空闲/工作中/会议中/等待你处理/已停用 与当前任务', async () => {
    const { pid, id } = await setup(['pm', 'dev'])
    const dev = id('dev')
    const pm = id('pm')

    let list = await agents(pid)
    expect(list.find((a) => a.instanceId === dev)!.state).toBe('idle')

    // 工作中（occupancy working）
    await svc.occupancy.acquire(pid, dev, `u_${dev}`, 'working')
    list = await agents(pid)
    expect(list.find((a) => a.instanceId === dev)!.state).toBe('working')

    // 会议中
    await svc.occupancy.acquire(pid, dev, 'm_x', 'meeting')
    list = await agents(pid)
    expect(list.find((a) => a.instanceId === dev)!.state).toBe('meeting')
    await svc.occupancy.release(pid, dev)

    // 等待你处理（有待批审批）
    await svc.approvals.request({
      projectId: pid,
      kind: 'command',
      actor: dev,
      sessionId: `u_${dev}`,
      summary: '执行命令：git push',
    })
    list = await agents(pid)
    expect(list.find((a) => a.instanceId === dev)!.state).toBe('waiting')

    // 当前任务（pm 有 in_progress 任务）
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '组织评审', assignee: pm, creator: 'user' },
    })
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${created.json().task.id}`,
      payload: { state: 'in_progress', actor: 'user' },
    })
    list = await agents(pid)
    expect(list.find((a) => a.instanceId === pm)!.currentTask?.title).toBe('组织评审')

    // 已停用
    await ready().inject({ method: 'DELETE', url: `/api/projects/${pid}/team/${dev}` })
    list = await agents(pid)
    expect(list.find((a) => a.instanceId === dev)!.state).toBe('disabled')
  }, 20000)
})

describe('任务状态由角色自管', () => {
  it('受派者可自行开工/完成；非受派者（非协调者）被拒', async () => {
    const { pid, id } = await setup(['pm', 'dev'])
    const dev = id('dev')
    const pm = id('pm')
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '实现核心玩法', assignee: dev, creator: 'user' },
    })
    const tid = created.json().task.id

    // 受派者自己开工（不触发自己唤醒自己）
    const start = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'in_progress', actor: dev },
    })
    expect(start.statusCode).toBe(200)
    expect(start.json().task.state).toBe('in_progress')

    // 非受派者角色（乙模式下）被拒
    const other = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'blocked', actor: pm },
    })
    expect(other.statusCode).toBe(409)

    // 受派者自行置 done（结算 code 改动后置终态）
    const done = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'done', actor: dev },
    })
    expect(done.statusCode).toBe(200)
    expect(done.json().task.state).toBe('done')
  }, 20000)

  it('task_update 工具：受派者汇报完成（默认作用于当前任务）', async () => {
    const { pid, id, team } = await setup(['dev'])
    const dev = id('dev')
    const member = team.find((t) => t.instanceId === dev)!
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '写 README', assignee: dev, creator: 'user' },
    })
    const taskId = created.json().task.id
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${taskId}`,
      payload: { state: 'in_progress', actor: 'user' },
    })

    const gateway = scripted([
      [
        {
          toolCall: { index: 0, id: 'c1', name: 'task_update', argumentsDelta: '{"state":"done"}' },
        },
      ],
      [{ content: '任务已完成并汇报。' }],
    ])
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: toolRuntime(async () => ({ id: taskId, title: '写 README', desc: '' })),
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev}`,
      member,
      scenario: 'ts',
    })

    const tasks = await svc.tasks.list(pid)
    expect(tasks[0]!.state).toBe('done')
  }, 20000)
})

describe('任意角色可发起会议（meeting_start/meeting_close 工具）', () => {
  it('dev 发起评审会 → 会议 open（受邀 AI 成员自动接受）+ 占用=会议中；主持人可结束', async () => {
    await boot({ autoStart: true, autoClose: false })
    const { pid, id, team } = await setup(['dev', 'pm', 'qa'])
    const dev = id('dev')
    const pm = id('pm')
    const qa = id('qa')
    const member = team.find((t) => t.instanceId === dev)!

    const gateway = scripted([
      [
        {
          toolCall: {
            index: 0,
            id: 'm1',
            name: 'meeting_start',
            argumentsDelta: JSON.stringify({
              topic: '接口方案对齐',
              desc: 'dev 与 qa 对齐接口与验收口径',
              members: [pm, qa],
            }),
          },
        },
      ],
      [{ content: '会议已发起并开始。' }],
    ])
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: toolRuntime(),
    })
    await loop.runDirectTurn({ projectId: pid, sessionId: `u_${dev}`, member, scenario: 'ts' })

    const meetings = await svc.meetings.list(pid)
    expect(meetings).toHaveLength(1)
    const m = meetings[0]!
    expect(m.meeting.host).toBe(dev)
    expect(m.meeting.topic).toBe('接口方案对齐')
    expect(m.meeting.desc).toBe('dev 与 qa 对齐接口与验收口径')
    expect(m.meeting.members.sort()).toEqual([pm, qa].sort())
    expect(m.state).toBe('open')

    // 参会角色占用=会议中（团队状态可显示）
    expect((await svc.occupancy.get(pid, pm))?.activity).toBe('meeting')
    expect((await svc.occupancy.get(pid, qa))?.activity).toBe('meeting')

    // 主持人结束会议（生成纪要）。后台链可能已自动收尾 → 两种结果都可接受，最终必须 closed
    const closed = await executeTool(
      'meeting_close',
      { meetingId: m.id },
      await buildToolEnv({ config, projectService: svc.projectService }, pid, dev, {
        sessionId: `u_${dev}`,
      }),
    )
    if (!closed.ok) expect(String(closed.reason ?? '')).toContain('仅 open/blocked')
    const deadline = Date.now() + 5000
    while ((await svc.meetings.list(pid))[0]!.state !== 'closed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await svc.meetings.list(pid))[0]!.state).toBe('closed')
  }, 20000)

  it('meeting_start 校验：参会人不存在/含自己 被拒', async () => {
    const { pid, id } = await setup(['dev', 'pm'])
    const dev = id('dev')
    const env = await buildToolEnv({ config, projectService: svc.projectService }, pid, dev, {
      sessionId: `u_${dev}`,
    })
    const self = await executeTool('meeting_start', { topic: 'x', members: [dev] }, env)
    expect(self.ok).toBe(false)
    const ghost = await executeTool('meeting_start', { topic: 'x', members: ['nobody_1'] }, env)
    expect(ghost.ok).toBe(false)
    expect(await svc.meetings.list(pid)).toHaveLength(0)
  }, 20000)

  it('会议真正"开起来"：主持人开场 + 受邀成员在会议会话发言', async () => {
    await boot({ autoStart: true, autoClose: true })
    const { pid, id, team } = await setup(['dev', 'pm'])
    const dev = id('dev')
    const pm = id('pm')
    const member = team.find((t) => t.instanceId === dev)!
    const gateway = scripted([
      [
        {
          toolCall: {
            index: 0,
            id: 'm1',
            name: 'meeting_start',
            argumentsDelta: JSON.stringify({
              topic: '接口方案对齐',
              desc: '对齐接口与验收口径',
              members: [pm],
            }),
          },
        },
      ],
      [{ content: '会议已发起，我在会议里做开场。' }],
    ])
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: toolRuntime(),
    })
    await loop.runDirectTurn({ projectId: pid, sessionId: `u_${dev}`, member, scenario: 'ts' })
    const mid = (await svc.meetings.list(pid))[0]!.id

    // 后台链：主持人开场 → 成员发言（会议会话里应同时出现两者的 message）
    const deadline = Date.now() + 15000
    let gotBoth = false
    while (!gotBoth && Date.now() < deadline) {
      const evts = await svc.sessionStore.readWindow(pid, mid, { limit: 1000 })
      const senders = new Set(
        evts.filter((e) => e.kind === 'message' && e.role === 'agent').map((e) => String(e.sender)),
      )
      gotBoth = senders.has(dev) && senders.has(pm)
      if (!gotBoth) await new Promise((r) => setTimeout(r, 50))
    }
    expect(gotBoth).toBe(true) // 主持人开场 + 受邀成员发言都已写入会议会话
    // 会议内发言不改状态；后台链收尾后平台会由发起人自动结束会议（生成纪要）
    const closeDeadline = Date.now() + 8000
    while ((await svc.meetings.list(pid))[0]!.state !== 'closed' && Date.now() < closeDeadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await svc.meetings.list(pid))[0]!.state).toBe('closed')
  }, 30000)

  it('会议上下文：能看到别人的发言；平台注入提示标记为系统消息', async () => {
    const { pid, id, team } = await setup(['dev', 'pm'])
    const dev = id('dev')
    const pm = id('pm')
    const member = team.find((t) => t.instanceId === dev)!

    // 1) 平台注入的提示必须是系统消息（前端不再显示成"我的发言"）
    await svc.sessionService.runAgentTurn(pid, `u_${dev}`, dev, {
      prompt: '【会议邀请】请发表意见',
    })
    const devEvts = await svc.sessionStore.readWindow(pid, `u_${dev}`, { limit: 100 })
    const injected = devEvts.find(
      (e) => e.kind === 'message' && String(e.content?.text ?? '').includes('【会议邀请】'),
    )
    expect(injected?.sender).toBe('system')
    expect(injected?.payload?.system).toBe(true)

    // 2) 会议会话里别人的发言要进入本成员上下文（否则主持人"读不到成员发言"）
    const meeting = await svc.meetings.create({
      projectId: pid,
      host: pm,
      topic: '接口对齐',
      desc: 'x',
      members: [dev],
    })
    const meta = await svc.sessionStore.readMeta(pid, meeting.id)
    await svc.sessionStore.appendEvent(meta, {
      kind: 'message',
      role: 'agent',
      sender: pm,
      content: { text: '我的意见是：先定接口再写页面', blocks: [] },
    })
    const captured: Array<Array<{ role: string; content: string }>> = []
    const gateway = {
      async *streamChat(opts: { messages: Array<{ role: string; content: string }> }) {
        captured.push(opts.messages)
        yield { content: '收到项目经理意见，我补充：接口用 REST。' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: meeting.id,
      member,
      scenario: 'ts',
      assignableMembers: team.map((t) => ({
        instanceId: t.instanceId,
        displayName: t.displayName,
      })),
    })
    const seen = JSON.stringify(captured[0] ?? [])
    expect(seen).toContain('【项目经理（pm_1）发言】')
    expect(seen).toContain('先定接口再写页面')
  }, 30000)

  it('meeting_talk 仅主持人可点名成员发言', async () => {
    const { pid, id } = await setup(['dev', 'pm'])
    const dev = id('dev')
    const pm = id('pm')
    const created = await svc.meetings.create({
      projectId: pid,
      host: dev,
      topic: '接口对齐',
      desc: 'x',
      members: [pm],
    })
    await svc.meetings.respond(pid, created.id, pm, 'accept')

    const nonHost = await executeTool(
      'meeting_talk',
      { meetingId: created.id, member: pm },
      await buildToolEnv({ config, projectService: svc.projectService }, pid, pm, {
        sessionId: `u_${pm}`,
      }),
    )
    expect(nonHost.ok).toBe(false)

    const host = await executeTool(
      'meeting_talk',
      { meetingId: created.id, member: pm, question: '你的结论？' },
      await buildToolEnv({ config, projectService: svc.projectService }, pid, dev, {
        sessionId: `u_${dev}`,
      }),
    )
    expect(host.ok).toBe(true)
    // 被点名成员的发言（异步）最终写入会议会话
    const deadline = Date.now() + 10000
    let spoke = false
    while (!spoke && Date.now() < deadline) {
      const evts = await svc.sessionStore.readWindow(pid, created.id, { limit: 1000 })
      spoke = evts.some((e) => e.kind === 'message' && e.role === 'agent' && e.sender === pm)
      if (!spoke) await new Promise((r) => setTimeout(r, 50))
    }
    expect(spoke).toBe(true)
  }, 30000)
})
