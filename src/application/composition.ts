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
import { ApprovalService } from './approval/approval-service.js'
import { ToolCoordinator } from './tools/tool-coordinator.js'
import { OccupancyStore } from './dispatcher/occupancy-store.js'
import { ArtifactService } from './artifact/artifact-service.js'
import { MemoryStore } from './memory/memory-store.js'
import { SummaryEngine } from './memory/summary-engine.js'
import { SearchService } from './search/search-service.js'
import { MeetingService } from './meeting/meeting-service.js'
import { TaskService } from './task/task-service.js'
import { CodeEditStore } from './code-edit/code-edit-store.js'
import { AttentionService } from './attention/attention-service.js'
import { registerServiceTools } from './tools/service-tools.js'
import { ModelGateway } from '../infra/model/gateway.js'
import { EventBus } from '../infra/bus/event-bus.js'
import type { ToolEnv } from '../infra/tools/executor.js'

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
  const teamService = new TeamService(projectService, roleService)
  const sessionStore = new SessionStore(projectsRoot)
  const occupancy = new OccupancyStore(projectsRoot)
  const gateway = new ModelGateway({ models: config.models })
  const memory = new MemoryStore(projectsRoot)
  const summary = new SummaryEngine(sessionStore)
  const loop = new AgentLoopRunner({
    store: sessionStore,
    gateway,
    bus,
    occupancy,
    windowSize: config.context.session.rawWindow,
  })
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
  )
  const search = new SearchService(projectsRoot, sessionStore)
  const codeEdits = new CodeEditStore(projectsRoot)
  // 应用级工具注册（记忆/检索/受控编辑）：组合时执行一次（模块级 registry，重复调用幂等覆盖）
  registerServiceTools({ memory, search, codeEdits })
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
    // 激活即唤醒（D18-③）：向受派者 user 会话注入唤醒消息并触发一轮
    async (pid, assignee, title, taskId) => {
      await sessionService
        .sendUserMessage(pid, `u_${assignee}`, `【系统】请开始执行任务 ${taskId}：${title}`)
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
  const attention = new AttentionService(approvals, meetings)

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
    attention,
  }
}

/** 组装 ToolEnv（路径根 + 项目策略）供工具执行/审批续跑使用。 */
export async function composeToolEnv(
  svc: Services,
  projectId: string,
  instanceId: string,
): Promise<ToolEnv> {
  const project = await svc.projectService.get(projectId)
  const team = await svc.projectService.listTeam(projectId)
  const member = team.find((m) => m.instanceId === instanceId)
  if (!member) throw new Error(`实例不存在: ${instanceId}`)
  const projectsRoot = join(svc.config.dataDir, 'projects')
  const runtimeRoot = join(projectsRoot, projectId)
  return {
    roots: {
      wsRoot: join(runtimeRoot, 'workspaces', instanceId),
      workdirRoot: project.workdir,
      roRoots: [],
      runtimeRoot,
    },
    instanceId,
    sessionType: 'user',
    projectId,
    approvalPolicy: project.approvalPolicy,
    offline: svc.config.sandbox.network === 'offline',
  }
}
