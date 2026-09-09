/**
 * 团队（角色实例）应用服务。
 * 职责：模板→实例的创建（D16-⑤ 快照默认值；D14-3 MVP 每项目每模板至多 1 实例）、
 * 实例更新与停用/启用（D14-9）。实例数组存于 project.json，由 ProjectService 串行落盘。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso } from '../../infra/util/id.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'
import type { RoleTemplate } from '../../shared/types/role.js'
import { ProjectService } from '../project/project-service.js'
import { RoleService } from '../roles/role-service.js'

export interface TeamAddInput {
  roleTemplateId: string
  displayName?: string
  /** 提示词覆盖（缺省=模板 systemPrompt 快照） */
  prompt?: string | null
  /** 模型覆盖（缺省=模板 defaultModel 快照），引用 provider id */
  model?: string
  loop?: { strategy: string; params?: Record<string, unknown> }
  /** 工具集覆盖（缺省=模板 tools 快照） */
  tools?: string[] | null
}

export type TeamPatchInput = Partial<
  Pick<TeamMemberConfig, 'displayName' | 'prompt' | 'model' | 'loop' | 'tools'>
>

export class TeamService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly roleService: RoleService,
  ) {}

  /** 由模板快照生成实例（每项目每模板至多 1 实例，D14-3）。 */
  async add(projectId: string, input: TeamAddInput): Promise<TeamMemberConfig> {
    const roleId = input.roleTemplateId
    if (!roleId) throw new AppError(ErrorCodes.VALIDATION, 'roleTemplateId 必填')
    const tpl = await this.roleService.get(roleId)

    const team = await this.projectService.listTeam(projectId)
    if (team.some((m) => m.roleTemplateId === roleId)) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `本项目已存在该模板实例: ${roleId}（MVP 每模板至多 1 实例）`,
      )
    }

    const member = snapshotInstance(tpl, input)
    return this.projectService.addMember(projectId, member)
  }

  async list(projectId: string): Promise<TeamMemberConfig[]> {
    return this.projectService.listTeam(projectId)
  }

  async get(projectId: string, instanceId: string): Promise<TeamMemberConfig> {
    const team = await this.projectService.listTeam(projectId)
    const m = team.find((x) => x.instanceId === instanceId)
    if (!m) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${instanceId}`)
    return m
  }

  async patch(
    projectId: string,
    instanceId: string,
    patch: TeamPatchInput,
  ): Promise<TeamMemberConfig> {
    return this.projectService.patchMember(projectId, instanceId, patch)
  }

  /** 停用实例：enabled=false（保留数据与历史，D14-9）。 */
  async disable(projectId: string, instanceId: string): Promise<void> {
    await this.projectService.setMemberEnabled(projectId, instanceId, false)
  }

  /** 重新启用实例。 */
  async enable(projectId: string, instanceId: string): Promise<void> {
    await this.projectService.setMemberEnabled(projectId, instanceId, true)
  }
}

/** 实例 = 模板快照 + 覆盖项（D16-⑤：此后模板变更不影响既有实例）。
 *  instanceId 规则：MVP 每模板至多 1 实例（D14-3）→ `${roleId}_1` 确定性命名；多实例为后续版本。
 */
function snapshotInstance(tpl: RoleTemplate, input: TeamAddInput): TeamMemberConfig {
  const instanceId = `${tpl.roleId}_1`
  const ts = nowIso()
  return {
    instanceId,
    roleTemplateId: tpl.roleId,
    displayName: input.displayName ?? tpl.name,
    prompt: input.prompt === undefined ? tpl.systemPrompt : input.prompt,
    model: input.model ?? tpl.defaultModel,
    loop: input.loop
      ? { strategy: input.loop.strategy, params: input.loop.params ?? {} }
      : { ...tpl.defaultLoop },
    tools: input.tools === undefined ? [...tpl.tools] : input.tools,
    enabled: true,
    createdAt: ts,
  }
}
