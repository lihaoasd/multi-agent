import type { ConfigProvider } from '../../ports/config'
import type { ProjectStore } from '../../ports/project'
import type { SessionType } from '../../ports/session'
import type { ToolRegistry } from '../../ports/tools'
import { ok, type Result } from '../../shared/result'
import type { MemoryService } from '../../ports/memory'
import type { ArtifactService } from '../../ports/artifact'
import type { TaskService } from '../../ports/task'
import type { TeamService } from '../team/team-service'
import type { OrchestrationService } from '../../ports/orchestration'
import type { RoleTemplateStore } from '../../ports/role-templates'
import { buildAgentContext, type ContextBlock } from './context-builder'

export interface PromptPreviewServiceOptions {
  readonly projects: ProjectStore
  readonly team: TeamService
  readonly tools: ToolRegistry
  readonly config: ConfigProvider
  /** 与运行期同源的记忆来源（预览可见 global-memory / role-memory 块） */
  readonly memory: MemoryService
  /** 与运行期同源的任务与产出物来源（预览可见 task-context / artifact-index 块） */
  readonly tasks: TaskService
  readonly artifacts: ArtifactService
  /** 与运行期同源的团队/出边来源（S50/D53：预览可见 team-roster / pending-tasks 块） */
  readonly orchestration: OrchestrationService
  readonly roleTemplates: RoleTemplateStore
}

export interface PromptPreview {
  readonly sessionType: SessionType
  readonly blocks: readonly ContextBlock[]
  readonly text: string
}

/**
 * 系统提示词预览（contract.md：`GET /api/projects/:pid/agents/:iid/system-prompt`）。
 * **与运行期同源**：复用 `buildAgentContext`，只看不落盘（agent-templates.md §3 契约）。
 */
export interface PromptPreviewService {
  preview(projectId: string, instanceId: string, sessionType?: SessionType): Promise<Result<PromptPreview>>
}

export function createPromptPreviewService(options: PromptPreviewServiceOptions): PromptPreviewService {
  const platform = options.config.get()

  return {
    async preview(projectId, instanceId, sessionType = 'user'): Promise<Result<PromptPreview>> {
      const project = await options.projects.get(projectId)
      if (!project.ok) return project
      const effective = await options.team.effectiveConfig(projectId, instanceId)
      if (!effective.ok) return effective

      const toolNames = effective.value.tools.length > 0 ? effective.value.tools : options.tools.list().map((item) => item.name)
      const toolSchemas = options.tools.schemasFor(toolNames, sessionType)
      const memories = await options.memory.activeFor(projectId, instanceId)
      const activeTask = await options.tasks.activeFor(projectId, instanceId)
      const delegatedTasks = await options.tasks.delegatedFor(projectId, instanceId)
      // S50/D53：与运行期同源——团队职能、我的出边、待领取任务
      const instances = await options.team.listInstances(projectId)
      const templates = await options.roleTemplates.list()
      const dutyOf = (roleTemplateId: string): string | undefined =>
        templates.ok ? templates.value.find((item) => item.roleId === roleTemplateId)?.description : undefined
      const team = instances.ok
        ? instances.value.map((item) => {
            const duty = dutyOf(item.roleTemplateId)
            return {
              instanceId: item.instanceId,
              displayName: item.displayName,
              roleTemplateId: item.roleTemplateId,
              ...(duty === undefined ? {} : { duty }),
              enabled: item.enabled,
            }
          })
        : []
      const outgoing = await options.orchestration.outgoingOf(projectId, instanceId)
      const todoTasks = await options.tasks.list(projectId, { assignee: instanceId, state: 'todo' })
      const owners = await options.artifacts.listOwners(projectId)
      const artifacts = await options.artifacts.list(projectId, { limit: 10 })

      const built = buildAgentContext({
        project: { id: project.value.id, name: project.value.name, workdir: project.value.workdir },
        effective: effective.value,
        history: [],
        toolSchemas,
        memories: memories.ok ? memories.value : [],
        // 检索片段依赖"本次用户消息"，预览无消息故不注入（运行期才可能出现 retrieval 块）
        snippets: [],
        ...(activeTask.ok && activeTask.value !== null ? { task: activeTask.value } : {}),
        ...(delegatedTasks.ok && delegatedTasks.value.length > 0 ? { delegatedTasks: delegatedTasks.value } : {}),
        ...(team.length > 0 ? { team } : {}),
        ...(outgoing.ok && outgoing.value.length > 0 ? { delegatesTo: outgoing.value } : {}),
        ...(todoTasks.ok && todoTasks.value.length > 0 ? { pendingTasks: todoTasks.value } : {}),
        ownership: {
          mine: owners.ok ? owners.value.filter((item) => item.owner === instanceId) : [],
          others: owners.ok ? owners.value.filter((item) => item.owner !== instanceId) : [],
        },
        artifacts: artifacts.ok ? artifacts.value : [],
        limits: {
          rawWindow: platform.context.session.rawWindow,
          maxCharsPerMsg: platform.context.session.maxCharsPerMsg,
          maxPromptChars: platform.models.maxPromptChars,
          maxSnippets: platform.context.search.maxSnippets,
        },
      })
      return ok({ sessionType, blocks: built.blocks, text: built.text })
    },
  }
}
