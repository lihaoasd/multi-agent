import type { ConfigProvider } from '../../ports/config'
import type { ProjectStore } from '../../ports/project'
import type { SessionType } from '../../ports/session'
import type { ToolRegistry } from '../../ports/tools'
import { ok, type Result } from '../../shared/result'
import type { MemoryService } from '../../ports/memory'
import type { TeamService } from '../team/team-service'
import { buildAgentContext, type ContextBlock } from './context-builder'

export interface PromptPreviewServiceOptions {
  readonly projects: ProjectStore
  readonly team: TeamService
  readonly tools: ToolRegistry
  readonly config: ConfigProvider
  /** 与运行期同源的记忆来源（预览可见 global-memory / role-memory 块） */
  readonly memory: MemoryService
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

      const built = buildAgentContext({
        project: { id: project.value.id, name: project.value.name, workdir: project.value.workdir },
        effective: effective.value,
        history: [],
        toolSchemas,
        memories: memories.ok ? memories.value : [],
        // 检索片段依赖"本次用户消息"，预览无消息故不注入（运行期才可能出现 retrieval 块）
        snippets: [],
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
