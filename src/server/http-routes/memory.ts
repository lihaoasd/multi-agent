import type { FastifyInstance } from 'fastify'
import { MEMORY_TYPES, type MemoryScope, type MemoryService, type MemoryType } from '../../ports/memory'
import type { SearchScope, SearchService } from '../../ports/search'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'

/**
 * 记忆与检索路由（contract.md §2「产出物 / 任务 / 审批 / 搜索」）：
 * - `GET /api/projects/:pid/memories?scope=&instanceId=&type=&state=&limit=`：记忆列表（只读浏览）
 * - `GET /api/projects/:pid/search?q=&scope=|type=&sessionId=&limit=`：关键词检索（会话/记忆分组）
 * - `GET /api/projects/:pid/search/stats`、`POST /api/projects/:pid/search/reindex`：索引派生数据
 *
 * 本组接口是**用户（老板）视角**：不受可见性限制（D18-② 的用户侧例外）；
 * Agent 侧检索能力由 `session_search`/`memory_search` 工具提供，同样经可见性收口。
 */

export interface MemoryRouteContext {
  readonly memory: MemoryService
  readonly search: SearchService
}

function queryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function queryNumber(query: Record<string, unknown>, key: string): number | undefined {
  const value = queryString(query, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const SEARCH_SCOPES: readonly SearchScope[] = ['all', 'session', 'memory']

export function registerMemoryRoutes(app: FastifyInstance, context: MemoryRouteContext): void {
  const { memory, search } = context

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/memories', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const scope = queryString(query, 'scope')
    if (scope !== undefined && scope !== 'global' && scope !== 'agent') {
      return replyFromResult(reply, err('ERR_VALIDATION', `未知记忆范围：${scope}`, { allowed: ['global', 'agent'] }))
    }
    const type = queryString(query, 'type')
    if (type !== undefined && !(MEMORY_TYPES as readonly string[]).includes(type)) {
      return replyFromResult(reply, err('ERR_VALIDATION', `未知记忆类型：${type}`, { allowed: MEMORY_TYPES }))
    }
    const state = queryString(query, 'state')
    if (state !== undefined && state !== 'active' && state !== 'superseded') {
      return replyFromResult(reply, err('ERR_VALIDATION', `未知记忆状态：${state}`, { allowed: ['active', 'superseded'] }))
    }
    const instanceId = queryString(query, 'instanceId')
    const rawLimit = queryNumber(query, 'limit')
    const limit = rawLimit === undefined ? 100 : Math.min(Math.max(Math.floor(rawLimit), 1), 500)

    const listed = await memory.list(request.params.pid, {
      ...(scope === undefined ? {} : { scope: scope as MemoryScope }),
      ...(type === undefined ? {} : { type: type as MemoryType }),
      ...(state === undefined ? {} : { state }),
      ...(instanceId === undefined ? {} : { instanceId }),
      limit,
    })
    if (!listed.ok) return replyFromResult(reply, listed)
    return replyFromResult(reply, { ok: true as const, value: { entries: listed.value, count: listed.value.length } })
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/search', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const text = queryString(query, 'q') ?? ''
    // `scope` 与 `type` 同义（contract 用 `type`，实现内部统一叫 scope）
    const scopeRaw = queryString(query, 'scope') ?? queryString(query, 'type')
    if (scopeRaw !== undefined && !SEARCH_SCOPES.includes(scopeRaw as SearchScope)) {
      return replyFromResult(
        reply,
        err('ERR_VALIDATION', `未知检索范围：${scopeRaw}`, { allowed: SEARCH_SCOPES }),
      )
    }
    const sessionId = queryString(query, 'sessionId')
    const rawLimit = queryNumber(query, 'limit')
    const limit = rawLimit === undefined ? 20 : Math.min(Math.max(Math.floor(rawLimit), 1), 100)

    const hits = await search.search({
      projectId: request.params.pid,
      query: text,
      viewer: { kind: 'user' },
      ...(scopeRaw === undefined ? {} : { scope: scopeRaw as SearchScope }),
      ...(sessionId === undefined ? {} : { sessionId }),
      limit,
    })
    if (!hits.ok) return replyFromResult(reply, hits)
    return replyFromResult(reply, {
      ok: true as const,
      value: {
        query: text,
        count: hits.value.length,
        sessionHits: hits.value.filter((hit) => hit.scope === 'session'),
        memoryHits: hits.value.filter((hit) => hit.scope === 'memory'),
      },
    })
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/search/stats', async (request, reply) =>
    replyFromResult(reply, await search.stats(request.params.pid)),
  )

  app.post<{ Params: { pid: string } }>('/api/projects/:pid/search/reindex', async (request, reply) =>
    replyFromResult(reply, await search.reindex(request.params.pid)),
  )
}
