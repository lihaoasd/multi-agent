import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { IdGenerator } from '../../ports/id'
import type {
  AppendMemoryInput,
  MemoryEntry,
  MemoryService,
  MemoryStore,
} from '../../ports/memory'
import { GLOBAL_MEMORY_TYPES, MEMORY_TYPES } from '../../ports/memory'
import type { InstanceId } from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

/**
 * L3 长期记忆用例实现（memory.md §4）：
 * - 角色记忆：Agent 可随时写自己的（`appendOwn`）；
 * - 全局记忆：**写入白名单**（决策/需求/进度类，且只由引擎/用户确认路径调用 `recordGlobal`）。
 */

export const MEMORY_LIMITS = {
  contentMaxChars: 2_000,
  tagsMax: 10,
  refsMax: 20,
} as const

export interface MemoryServiceOptions {
  readonly store: MemoryStore
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
}

function validate(input: AppendMemoryInput): Result<void> {
  const content = input.content.trim()
  if (content.length === 0) return err('ERR_VALIDATION', '记忆内容不能为空')
  if (content.length > MEMORY_LIMITS.contentMaxChars) {
    return err('ERR_VALIDATION', `记忆内容过长（上限 ${MEMORY_LIMITS.contentMaxChars} 字）`)
  }
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
    return err('ERR_VALIDATION', `未知记忆类型：${input.type}`, { allowed: MEMORY_TYPES })
  }
  if ((input.tags?.length ?? 0) > MEMORY_LIMITS.tagsMax) {
    return err('ERR_VALIDATION', `标签过多（上限 ${MEMORY_LIMITS.tagsMax} 个）`)
  }
  if ((input.refs?.length ?? 0) > MEMORY_LIMITS.refsMax) {
    return err('ERR_VALIDATION', `引用过多（上限 ${MEMORY_LIMITS.refsMax} 个）`)
  }
  return ok(undefined)
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const platform = options.config.get()

  const write = async (
    input: AppendMemoryInput,
    scope: MemoryEntry['scope'],
    instanceId: InstanceId | null,
  ): Promise<Result<MemoryEntry>> => {
    const checked = validate(input)
    if (!checked.ok) return checked
    const entry: MemoryEntry = {
      id: options.ids.next('mem'),
      ts: options.clock.now().toISOString(),
      scope,
      instanceId,
      type: input.type,
      content: input.content.trim(),
      source: { sessionId: input.sessionId, seq: input.seq },
      tags: input.tags ?? [],
      refs: input.refs ?? [],
      state: 'active',
      supersededBy: null,
    }
    return options.store.append(input.projectId, entry)
  }

  return {
    async appendOwn(input) {
      return write(input, 'agent', input.instanceId)
    },

    async recordGlobal(input) {
      if (!GLOBAL_MEMORY_TYPES.includes(input.type)) {
        return err('ERR_FORBIDDEN', `全局记忆只接受决策/需求/进度类条目（收到 ${input.type}）`, {
          allowed: GLOBAL_MEMORY_TYPES,
        })
      }
      return write(input, 'global', null)
    },

    async list(projectId, filter) {
      return options.store.list(projectId, filter)
    },

    async supersede(projectId, entryId, supersededBy) {
      return options.store.supersede(projectId, entryId, supersededBy)
    },

    async activeFor(projectId, instanceId) {
      return options.store.activeFor(projectId, {
        instanceId,
        globalLimit: platform.context.global.maxEntries,
        roleLimit: platform.context.role.maxEntries,
      })
    },
  }
}
