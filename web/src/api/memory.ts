import { apiRequest } from './client'

/** 记忆与检索（contract.md §2「产出物 / 任务 / 审批 / 搜索」；S5） */

export type MemoryScope = 'global' | 'agent'
export type MemoryType = 'fact' | 'decision' | 'preference' | 'commitment' | 'requirement' | 'progress' | 'artifact_index'
export type MemoryState = 'active' | 'superseded'

export interface MemoryEntry {
  readonly id: string
  readonly ts: string
  readonly scope: MemoryScope
  readonly instanceId: string | null
  readonly type: MemoryType
  readonly content: string
  readonly source: { readonly sessionId: string; readonly seq: number }
  readonly tags: readonly string[]
  readonly refs: readonly string[]
  readonly state: MemoryState
  readonly supersededBy: string | null
}

export interface SearchHit {
  readonly scope: 'session' | 'memory'
  readonly sessionId: string | null
  readonly seq: number | null
  readonly entryId: string | null
  readonly kind: string | null
  readonly text: string
  readonly score: number
  readonly tokens: readonly string[]
}

export interface SearchResult {
  readonly query: string
  readonly count: number
  readonly sessionHits: readonly SearchHit[]
  readonly memoryHits: readonly SearchHit[]
}

export interface SearchStats {
  readonly documents: number
  readonly tokens: number
  readonly builtAt: string | null
}

export const memoryApi = {
  list: (
    projectId: string,
    filter?: { scope?: MemoryScope; instanceId?: string; type?: MemoryType; state?: MemoryState; limit?: number },
  ): Promise<{ entries: MemoryEntry[]; count: number }> => {
    const params = new URLSearchParams()
    if (filter?.scope !== undefined) params.set('scope', filter.scope)
    if (filter?.instanceId !== undefined) params.set('instanceId', filter.instanceId)
    if (filter?.type !== undefined) params.set('type', filter.type)
    if (filter?.state !== undefined) params.set('state', filter.state)
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
    const query = params.toString()
    return apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/memories${query.length > 0 ? `?${query}` : ''}`)
  },

  search: (
    projectId: string,
    query: string,
    options?: { scope?: 'all' | 'session' | 'memory'; sessionId?: string; limit?: number },
  ): Promise<SearchResult> => {
    const params = new URLSearchParams()
    params.set('q', query)
    if (options?.scope !== undefined) params.set('scope', options.scope)
    if (options?.sessionId !== undefined) params.set('sessionId', options.sessionId)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    return apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/search?${params.toString()}`)
  },

  stats: (projectId: string): Promise<SearchStats> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/search/stats`),

  reindex: (projectId: string): Promise<SearchStats> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/search/reindex`),
}
