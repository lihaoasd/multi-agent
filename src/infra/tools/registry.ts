import type {
  PackageId,
  ToolDefinition,
  ToolName,
  ToolPackageInfo,
  ToolPackageRegistry,
  ToolRegistry,
} from '../../ports/tools'
import type { SessionType } from '../../ports/session'
import { BUILTIN_TOOL_PACKAGES } from './packages'

/** 工具注册表（"注册即扩展"）：新增工具只需 register，不改调度代码 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<ToolName, { definition: ToolDefinition; handler: import('../../ports/tools').ToolHandler }>()

  return {
    register(definition, handler): void {
      if (tools.has(definition.name)) {
        throw new Error(`ERR_INTERNAL: 工具重复注册：${definition.name}`)
      }
      tools.set(definition.name, { definition, handler })
    },

    get(name: ToolName) {
      return tools.get(name)
    },

    list(filter): readonly ToolDefinition[] {
      let definitions = [...tools.values()].map((entry) => entry.definition)
      if (filter?.package !== undefined) definitions = definitions.filter((item) => item.package === filter.package)
      if (filter?.availableIn !== undefined) {
        const sessionType = filter.availableIn
        definitions = definitions.filter((item) => item.availableIn.includes(sessionType))
      }
      if (filter?.names !== undefined) {
        const wanted = new Set(filter.names)
        definitions = definitions.filter((item) => wanted.has(item.name))
      }
      return definitions.sort((a, b) => a.name.localeCompare(b.name))
    },

    schemasFor(names, sessionType: SessionType) {
      const wanted = new Set(names)
      return [...tools.values()]
        .filter((entry) => wanted.has(entry.definition.name) && entry.definition.availableIn.includes(sessionType))
        .map((entry) => ({
          name: entry.definition.name,
          description: entry.definition.description,
          parameters: entry.definition.paramsSchema,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

/** 工具包注册表：元数据随仓库（`shared/tool-packages.ts`），运行期可用性看注册表 */
export function createToolPackageRegistry(): ToolPackageRegistry {
  const packages = new Map<PackageId, ToolPackageInfo>(BUILTIN_TOOL_PACKAGES.map((item) => [item.id, item]))
  return {
    list(): readonly ToolPackageInfo[] {
      return [...packages.values()]
    },
    get(id: PackageId): ToolPackageInfo | undefined {
      return packages.get(id)
    },
  }
}
