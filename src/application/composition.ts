/**
 * 服务组合根（依赖装配）：config → 各 store/service → HTTP/WS。
 * 供 index.ts 启动与测试注入复用。
 */
import { join } from 'node:path'

import type { PlatformConfig } from '../shared/config.js'
import { ProjectService } from './project/project-service.js'
import { RoleService } from './roles/role-service.js'
import { TeamService } from './team/team-service.js'
import { SessionStore } from './session/session-store.js'
import { SessionService } from './session/session-service.js'
import { AgentLoopRunner } from './agent-loop/loop-runner.js'
import type { ActiveTask, TurnContext } from './agent-loop/loop-runner.js'
import { ApprovalService } from './approval/approval-service.js'
import { ToolCoordinator } from './tools/tool-coordinator.js'
import { OccupancyStore } from './dispatcher/occupancy-store.js'
import { ArtifactService } from './artifact/artifact-service.js'
import { MemoryStore } from './memory/memory-store.js'
import { SummaryEngine } from './memory/summary-engine.js'
import { SearchService } from './search/search-service.js'
import { MeetingService } from './meeting/meeting-service.js'
import { TaskService } from './task/task-service.js'
import { dispatchTasksFromText } from './task/task-dispatch.js'
import { QuestionService } from './question/question-service.js'
import { CodeEditStore } from './code-edit/code-edit-store.js'
import { AttentionService } from './attention/attention-service.js'
import { registerServiceTools } from './tools/service-tools.js'
import { ModelGateway } from '../infra/model/gateway.js'
import { EventBus } from '../infra/bus/event-bus.js'
import type { ToolEnv } from '../infra/tools/executor.js'
import { executeTool, listToolDefs } from '../infra/tools/executor.js'

export interface Services {
  config: PlatformConfig
  bus: EventBus
  projectService: ProjectService
  roleService: RoleService
  teamService: TeamService
  sessionStore: SessionStore
  sessionService: SessionService
  gateway: ModelGateway
  approvals: ApprovalService
  tools: ToolCoordinator
  occupancy: OccupancyStore
  artifacts: ArtifactService
  memory: MemoryStore
  search: SearchService
  meetings: MeetingService
  tasks: TaskService
  questions: QuestionService
  attention: AttentionService
}

/** 组合全部服务。customRoleDir 缺省 = dataDir/roles。 */
export function composeServices(config: PlatformConfig, customRoleDir?: string): Services {
  const projectsRoot = join(config.dataDir, 'projects')
  const builtinRoleDir = config.roleDirs[0] ?? join(config.dataDir, 'src/shared/roles')
  const roleCustomDir = customRoleDir ?? config.roleDirs[1] ?? join(config.dataDir, 'roles')

  const bus = new EventBus()
  const projectService = new ProjectService(projectsRoot, {
    artifactPolicy: {
      codeSubmitApproval: config.approval.codeSubmitApproval,
      docSubmitApproval: config.approval.docSubmitApproval,
    },
    approvalPolicy: { highRiskCommands: config.approval.highRiskCommands },
  })
  const roleService = new RoleService(builtinRoleDir, roleCustomDir)
  const teamService = new TeamService(projectService, roleService, config.models.default)
  const sessionStore = new SessionStore(projectsRoot)
  const occupancy = new OccupancyStore(projectsRoot)
  const gateway = new ModelGateway({ models: config.models })
  const memory = new MemoryStore(projectsRoot)
  const summary = new SummaryEngine(sessionStore)
  const questions = new QuestionService(projectsRoot)
  // loop opts 可变：taskDispatch 依赖 tasks（后建），组合尾部再绑定（运行期读取）
  const loopOpts: ConstructorParameters<typeof AgentLoopRunner>[0] = {
    store: sessionStore,
    gateway,
    bus,
    occupancy,
    windowSize: config.context.session.rawWindow,
  }
  const loop = new AgentLoopRunner(loopOpts)
  const sessionService = new SessionService(
    sessionStore,
    bus,
    loop,
    async (pid, iid) => {
      const team = await teamService.list(pid)
      return team.find((m) => m.instanceId === iid) ?? null
    },
    async (pid) => {
      const p = await projectService.get(pid)
      return p.name
    },
    summary,
    async (pid) => teamService.list(pid),
  )
  const search = new SearchService(projectsRoot, sessionStore)
  const codeEdits = new CodeEditStore(projectsRoot)
  const meetings = new MeetingService(
    sessionStore,
    memory,
    async (pid, host, members) => {
      // 入会 = occupancy meeting 占用（MVP：状态落盘供 UI/调度查询）
      for (const m of [host, ...members]) await occupancy.acquire(pid, m, 'meeting-slot', 'meeting')
    },
    async (pid, mid) => {
      // 散会释放
      const meta = await sessionStore.tryReadMeta(pid, mid)
      if (meta?.participants?.agents) {
        for (const m of meta.participants.agents) await occupancy.release(pid, m)
      }
    },
    // 点名成员发言：在 meeting 会话内为该成员执行一轮（Mock 直答）
    async (pid, mid, instanceId, prompt) => {
      await sessionService.runAgentTurn(pid, mid, instanceId, { prompt })
    },
    // D17-⑦ 纪要转出任务（creator=user，来源=本会议）
    async (pid, input) => {
      const t = await tasks.create({
        projectId: pid,
        title: input.title,
        desc: input.desc,
        creator: 'user',
        assignee: input.assignee,
        sessionId: input.sessionId,
      })
      return { id: t.id }
    },
  )

  const approvals = new ApprovalService(
    projectsRoot,
    async (pid, sid, evt) => {
      const meta = await sessionStore.tryReadMeta(pid, sid)
      if (!meta) {
        throw new Error(`会话不存在: ${sid}`)
      }
      return sessionStore.appendEvent(meta, evt)
    },
    (_pid, rec) => {
      bus.emit('approval.result', rec.projectId, rec.sessionId ?? undefined, {
        approval: rec,
      } as unknown as Record<string, unknown>)
    },
  )
  const tools = new ToolCoordinator(approvals)
  const artifacts = new ArtifactService(projectsRoot, approvals, async (pid, sid, evt) => {
    const meta = await sessionStore.tryReadMeta(pid, sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    return sessionStore.appendEvent(meta, evt)
  })
  const tasks = new TaskService(
    projectsRoot,
    config.task.assignByAgent,
    // 激活即唤醒（D18-③）：向受派者 user 会话注入系统消息并触发一轮
    async (pid, assignee, title, taskId) => {
      await sessionService
        .sendUserMessage(pid, `u_${assignee}`, `【系统】请开始执行任务 ${taskId}：${title}`, {
          system: true,
        })
        .catch(() => undefined)
    },
    // D17-① done/terminated 前结算未结算 code 改动 → code artifact
    async (pid, task) => {
      await artifacts
        .settleCodeAggregation({
          projectId: pid,
          actor: task.assignee,
          taskId: task.id,
          taskTitle: task.title,
          edits: codeEdits,
        })
        .then(async (rec) => {
          if (rec) await tasks.linkArtifact(pid, task.id, rec.id)
        })
    },
  )
  const attention = new AttentionService(approvals, meetings, questions)

  // 应用级工具注册（记忆/检索/受控编辑/用户交互/派单）：组合时执行一次（模块级 registry，重复调用幂等覆盖）。
  // 放在 tasks 之后，以便把 TaskService 注入 task_assign 工具。
  registerServiceTools({
    memory,
    search,
    codeEdits,
    questions,
    tasks,
    meetings,
    listTeam: (pid) => projectService.listTeam(pid),
    // 会议内发言：在会议会话里为该实例跑一轮
    runMeetingTurn: async (pid, mid, instanceId, prompt) => {
      await sessionService.runAgentTurn(pid, mid, instanceId, { prompt })
    },
  })

  // 当前激活任务（in_progress 且属本会话）：系统提示注入 + workdir_edit 聚合锚点（D15）
  const activeTaskOf = async (ctx: TurnContext): Promise<ActiveTask | null> => {
    const list = await tasks.list(ctx.projectId, {
      assignee: ctx.member.instanceId,
      state: 'in_progress',
    })
    const t = list.find((x) => x.sessionId === ctx.sessionId) ?? list[0]
    return t ? { id: t.id, title: t.title, desc: t.desc } : null
  }

  // 工具循环（function-calling）：角色白名单 ∩ 注册表 ∩ 会话可用性。
  // ask_user / task_assign / task_update 为平台交互能力：user 会话始终可用
  // （老项目快照的 tools 里没有也能用）；task_assign 的角色权限在工具内部校验（仅 pm/product）。
  const PLATFORM_USER_TOOLS = new Set(['ask_user', 'task_assign', 'task_update'])
  loopOpts.toolRuntime = {
    listTools: (ctx, sessionType) => {
      const allowed = new Set(ctx.member.tools ?? [])
      return listToolDefs()
        .filter(
          (d) =>
            d.availableIn.includes(sessionType) &&
            (allowed.has(d.name) || (sessionType === 'user' && PLATFORM_USER_TOOLS.has(d.name))),
        )
        .map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.paramsSchema ?? { type: 'object', properties: {} },
        }))
    },
    exec: async (ctx, sessionType, name, args) => {
      const task = await activeTaskOf(ctx)
      const env = await buildToolEnv(
        { config, projectService },
        ctx.projectId,
        ctx.member.instanceId,
        {
          taskId: task?.id,
          sessionId: ctx.sessionId,
          sessionType: sessionType === 'meeting' ? 'meeting' : 'user',
        },
      )
      return executeTool(name, args, env)
    },
    requestApproval: async (ctx, name, args) => {
      if (name !== 'cmd_run') return null
      const argv = Array.isArray(args.args) ? args.args.map(String) : []
      const rec = await tools.requestCommand({
        projectId: ctx.projectId,
        actor: ctx.member.instanceId,
        sessionId: ctx.sessionId,
        summary: `执行命令：${String(args.program ?? '')} ${argv.join(' ')}`.trim().slice(0, 200),
        command: {
          program: String(args.program ?? ''),
          args: argv,
          cwd: String(args.cwd ?? 'workdir://'),
        },
      })
      return rec.id
    },
    activeTask: activeTaskOf,
    maxSteps: 6,
  }

  // 甲模式任务分派钩子（2026-09-09）：config.task.assignByAgent 时由 pm/product 的
  // user 会话回合解析分派指令并创建/激活任务（loop 运行期经 loopOpts 读取）。
  loopOpts.taskDispatch = config.task.assignByAgent
    ? {
        run: async (ctx, text) => {
          const emitTool = async (
            kind: 'tool_call' | 'tool_result',
            payload: Record<string, unknown>,
          ) => {
            const meta = await sessionStore.tryReadMeta(ctx.projectId, ctx.sessionId)
            if (!meta) return
            const evt = await sessionStore.appendEvent(meta, {
              kind,
              sender: ctx.member.instanceId,
              role: 'agent',
              payload,
            })
            bus.emitLogEvent(ctx.projectId, evt)
          }
          const team = await projectService.listTeam(ctx.projectId)
          return dispatchTasksFromText({
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            actorId: ctx.member.instanceId,
            actorName: ctx.member.displayName,
            text,
            team,
            tasks,
            emitTool,
          })
        },
      }
    : undefined

  return {
    config,
    bus,
    projectService,
    roleService,
    teamService,
    sessionStore,
    sessionService,
    gateway,
    approvals,
    tools,
    occupancy,
    artifacts,
    memory,
    search,
    meetings,
    tasks,
    questions,
    attention,
  }
}

/** 组装 ToolEnv（路径根 + 项目策略）供工具执行/审批续跑使用。 */
export async function composeToolEnv(
  svc: Services,
  projectId: string,
  instanceId: string,
  opts: { taskId?: string; sessionId?: string; sessionType?: 'user' | 'meeting' } = {},
): Promise<ToolEnv> {
  return buildToolEnv(
    { config: svc.config, projectService: svc.projectService },
    projectId,
    instanceId,
    opts,
  )
}

/** ToolEnv 构造（composition 内部与 composeToolEnv 共用）。 */
export async function buildToolEnv(
  deps: Pick<Services, 'config' | 'projectService'>,
  projectId: string,
  instanceId: string,
  opts: { taskId?: string; sessionId?: string; sessionType?: 'user' | 'meeting' } = {},
): Promise<ToolEnv> {
  const project = await deps.projectService.get(projectId)
  const team = await deps.projectService.listTeam(projectId)
  const member = team.find((m) => m.instanceId === instanceId)
  if (!member) throw new Error(`实例不存在: ${instanceId}`)
  const projectsRoot = join(deps.config.dataDir, 'projects')
  const runtimeRoot = join(projectsRoot, projectId)
  return {
    roots: {
      wsRoot: join(runtimeRoot, 'workspaces', instanceId),
      workdirRoot: project.workdir,
      roRoots: [],
      runtimeRoot,
    },
    instanceId,
    sessionType: opts.sessionType ?? 'user',
    projectId,
    approvalPolicy: project.approvalPolicy,
    offline: deps.config.sandbox.network === 'offline',
    taskId: opts.taskId,
    sessionId: opts.sessionId,
  }
}
