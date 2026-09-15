import type { ModelId } from '../../ports/model'
import type { RoleTemplateStore } from '../../ports/role-templates'
import type { ModelReference } from './validate'

/**
 * 模型条目的被引用查询（删除保护用，model-config.md §8 #9）。
 * 模板引用来自 `RoleTemplateStore`；项目实例引用在 S2 落地后并入同一查询。
 */
export interface ModelReferenceQuery {
  findModelReferrers(modelId: ModelId): Promise<readonly ModelReference[]>
  findInstancesReferrers?(modelId: ModelId): Promise<readonly ModelReference[]>
}

export function createTemplateModelReferenceQuery(store: RoleTemplateStore): ModelReferenceQuery {
  return {
    async findModelReferrers(modelId: ModelId): Promise<readonly ModelReference[]> {
      const templates = await store.list()
      if (!templates.ok) return []
      return templates.value
        .filter((template) => template.defaultModel === modelId)
        .map((template) => ({ kind: 'template' as const, id: template.roleId, label: template.name }))
    },
  }
}
