import type { MemoryEntry, MemoryService } from '../../ports/memory'
import type { SearchHit, SearchIndex, SearchService } from '../../ports/search'
import { canReadMemory, visibilityFor } from '../../domain/rules/visibility'
import { ok } from '../../shared/result'

/**
 * 检索用例实现（memory.md §5、D18-②）：
 * 索引只负责"命中什么"，**可见性在被调用方这层收口**（工具与 HTTP 接口共用同一份判定）。
 */

export interface SearchServiceOptions {
  readonly index: SearchIndex
  readonly memory: MemoryService
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  return {
    async search(input) {
      const query = input.query.trim()
      if (query.length === 0) return ok([])

      const hits = await options.index.query(input.projectId, query, {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        // 多取一些再做可见性过滤，避免过滤后结果过少
        limit: (input.limit ?? 20) * 3,
      })
      if (!hits.ok) return hits

      const scope = visibilityFor(input.viewer)
      // 用户侧不受限（null）→ 无需加载条目；Agent 侧按条目 scope/instanceId 判定
      let memories: Map<string, MemoryEntry> | null = null
      if (scope.instanceIds !== null) {
        const listed = await options.memory.list(input.projectId)
        memories = listed.ok ? new Map(listed.value.map((entry) => [entry.id, entry])) : new Map()
      }

      const limit = input.limit ?? 20
      const kept: SearchHit[] = []
      for (const hit of hits.value) {
        if (kept.length >= limit) break
        if (hit.scope === 'session') {
          if (scope.sessionIds !== null && (hit.sessionId === null || !scope.sessionIds.includes(hit.sessionId))) continue
        } else {
          if (hit.entryId === null) continue
          if (memories !== null) {
            const entry = memories.get(hit.entryId)
            if (entry === undefined || !canReadMemory(input.viewer, entry)) continue
          }
        }
        kept.push(hit)
      }
      return ok(kept)
    },

    async reindex(projectId) {
      return options.index.rebuild(projectId)
    },

    async stats(projectId) {
      return options.index.stats(projectId)
    },
  }
}
