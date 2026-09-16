import type { ModelId } from '../../ports/model'
import type { ProjectStore, RoleInstance } from '../../ports/project'
import { resolveEffectiveAgentConfig } from './effective-config'

/**
 * 模板与 Agent 的引用查询（S11）：
 * - `findTemplateReferrers`：删除模板前的引用保护（被项目实例引用 → 拒绝删除并点名）；
 * - `findUnconfiguredAgents`：**未配置模型**的 Agent（项目实例中启用且生效模型为空，D22-④），
 *   供"模型"模块展示计数。
 * 口径与 dispatcher 一致（S14 起为两级）：生效链 = `实例覆盖 → 模板快照`。
 */

export interface AgentReference {
  readonly projectId: string
  readonly projectName: string
  readonly instanceId: string
  readonly displayName: string
}

export interface TemplateReferenceQuery {
  findTemplateReferrers(roleId: string): Promise<readonly AgentReference[]>
  findUnconfiguredAgents(): Promise<readonly AgentReference[]>
}

export interface ProjectTemplateReferenceOptions {
  readonly projects: ProjectStore
}

interface AgentScanEntry {
  readonly ref: AgentReference
  readonly instance: RoleInstance
  readonly model: ModelId | null
}

export function createProjectTemplateReferenceQuery(
  options: ProjectTemplateReferenceOptions,
): TemplateReferenceQuery {
  const scan = async (): Promise<readonly AgentScanEntry[]> => {
    const listed = await options.projects.list()
    if (!listed.ok) return []
    const entries: AgentScanEntry[] = []
    for (const summary of listed.value) {
      const project = await options.projects.get(summary.id)
      if (!project.ok) continue
      for (const instance of project.value.team) {
        const effective = resolveEffectiveAgentConfig(instance)
        entries.push({
          ref: {
            projectId: project.value.id,
            projectName: project.value.name,
            instanceId: instance.instanceId,
            displayName: instance.displayName,
          },
          instance,
          model: effective.model,
        })
      }
    }
    return entries
  }

  return {
    async findTemplateReferrers(roleId: string): Promise<readonly AgentReference[]> {
      const entries = await scan()
      return entries
        .filter((entry) => entry.instance.roleTemplateId === roleId)
        .map((entry) => entry.ref)
    },

    async findUnconfiguredAgents(): Promise<readonly AgentReference[]> {
      const entries = await scan()
      // 只有"启用中"的实例需要模型；停用实例不参与统计
      return entries.filter((entry) => entry.instance.enabled && entry.model === null).map((entry) => entry.ref)
    },
  }
}
