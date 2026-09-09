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
import { ModelGateway } from '../infra/model/gateway.js'
import { EventBus } from '../infra/bus/event-bus.js'

export interface Services {
  config: PlatformConfig
  bus: EventBus
  projectService: ProjectService
  roleService: RoleService
  teamService: TeamService
  sessionStore: SessionStore
  sessionService: SessionService
  gateway: ModelGateway
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
  const gateway = new ModelGateway({ models: config.models })
  const loop = new AgentLoopRunner({
    store: sessionStore,
    gateway,
    bus,
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
  )

  return {
    config,
    bus,
    projectService,
    roleService,
    teamService,
    sessionStore,
    sessionService,
    gateway,
  }
}
