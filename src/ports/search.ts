import type { Result } from '../shared/result'
import type { ProjectId } from './project'
import type { EventKind, SessionId } from './session'
import type { Viewer } from './viewer'

/**
 * 检索端口（真源：docs/design/memory.md §8、data-storage.md §10、abstraction.md §4.1）。
 * MVP 为关键词倒排（2-gram + 字符回退，中文友好）；索引是**派生数据**，损坏可一键重建。
 */

export type SearchScope = 'all' | 'session' | 'memory'

export interface SearchHit {
  readonly scope: 'session' | 'memory'
  /** 命中位置：会话事件为 sessionId+seq；记忆条目为 entryId */
  readonly sessionId: SessionId | null
  readonly seq: number | null
  readonly entryId: string | null
  readonly kind: EventKind | null
  /** 命中文本（用于高亮与预览） */
  readonly text: string
  readonly score: number
  /** 命中的查询词元（用于前端高亮） */
  readonly tokens: readonly string[]
}

export interface SearchQueryOptions {
  readonly scope?: SearchScope
  /** 限定单条会话（会话内检索） */
  readonly sessionId?: SessionId
  readonly limit?: number
}

export interface SearchIndexStats {
  readonly documents: number
  readonly tokens: number
  readonly builtAt: string | null
}

export interface SearchIndex {
  /** 重建索引（可重复调用，结果幂等）；返回文档与词元规模 */
  rebuild(projectId: ProjectId): Promise<Result<SearchIndexStats>>
  query(projectId: ProjectId, text: string, options?: SearchQueryOptions): Promise<Result<readonly SearchHit[]>>
  stats(projectId: ProjectId): Promise<Result<SearchIndexStats>>
}

export interface SearchInput {
  readonly projectId: ProjectId
  readonly query: string
  readonly viewer: Viewer
  readonly scope?: SearchScope
  /** 会话内检索（限定单个会话） */
  readonly sessionId?: SessionId
  readonly limit?: number
}

export interface SearchStats {
  readonly documents: number
  readonly tokens: number
  readonly builtAt: string | null
}

/**
 * 检索用例端口（实现见 `application/search/search-service.ts`）：
 * 索引只负责"命中什么"，**可见性在用例层收口**（工具与 HTTP 接口共用同一份判定）。
 */
export interface SearchService {
  search(input: SearchInput): Promise<Result<readonly SearchHit[]>>
  /** 项目级索引重建（`npm run reindex` 与接口共用） */
  reindex(projectId: ProjectId): Promise<Result<SearchStats>>
  stats(projectId: ProjectId): Promise<Result<SearchStats>>
}
