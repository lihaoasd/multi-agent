import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { MemoryStore } from '../../ports/memory'
import type { ProjectId } from '../../ports/project'
import type { SearchHit, SearchIndex, SearchIndexStats, SearchQueryOptions } from '../../ports/search'
import type { EventKind, SessionId, SessionLogStore, SessionMetaStore } from '../../ports/session'
import { cjkChars, snippetAround, tokenize } from '../../shared/text'
import { ok, type Result } from '../../shared/result'

export interface KeywordIndexOptions {
  readonly fileStore: FileStore
  readonly clock: Clock
  readonly dataDir: RelPath
  readonly sessionMetaStore: SessionMetaStore
  readonly sessionLogStore: SessionLogStore
  readonly memoryStore: MemoryStore
  /** 单条命中文本保留上限（避免索引文件膨胀） */
  readonly maxTextChars?: number
}

const SCHEMA_VERSION = 1
const DEFAULT_MAX_TEXT_CHARS = 1_000
const DEFAULT_LIMIT = 20
/** 命中位置的引用键：会话事件 `s:<sessionId>:<seq>`、记忆条目 `m:<entryId>` */
const REF_PREFIX = { session: 's', memory: 'm' } as const

interface IndexedDoc {
  readonly scope: 'session' | 'memory'
  readonly sessionId: SessionId | null
  readonly seq: number | null
  readonly entryId: string | null
  readonly kind: EventKind | null
  readonly instanceId: string | null
  readonly ts: string
  readonly text: string
}

interface ProjectIndex {
  builtAt: string | null
  postings: Map<string, Set<string>>
  charPostings: Map<string, Set<string>>
  docs: Map<string, IndexedDoc>
  /** 每个会话已索引到的最大 seq（增量 sync 的游标） */
  indexedSeq: Map<SessionId, number>
  indexedMemoryIds: Set<string>
}

interface PersistedIndex {
  readonly schemaVersion: number
  readonly builtAt: string | null
  readonly postings: Readonly<Record<string, readonly string[]>>
  readonly charPostings: Readonly<Record<string, readonly string[]>>
  readonly docs: Readonly<Record<string, IndexedDoc>>
  readonly indexedSeq: Readonly<Record<string, number>>
  readonly indexedMemoryIds: readonly string[]
}

function emptyIndex(): ProjectIndex {
  return {
    builtAt: null,
    postings: new Map(),
    charPostings: new Map(),
    docs: new Map(),
    indexedSeq: new Map(),
    indexedMemoryIds: new Set(),
  }
}

function refKeyOfEvent(sessionId: SessionId, seq: number): string {
  return `${REF_PREFIX.session}:${sessionId}:${seq}`
}

function refKeyOfMemory(entryId: string): string {
  return `${REF_PREFIX.memory}:${entryId}`
}

function ownerOfSession(sessionId: SessionId): string {
  return sessionId.replace(/^u_/, '')
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => asText(item)).filter((item): item is string => item !== null)
    return parts.length === 0 ? null : parts.join(' ')
  }
  if (typeof value === 'object' && value !== null) {
    const parts = Object.values(value as Record<string, unknown>)
      .map((item) => asText(item))
      .filter((item): item is string => item !== null)
    return parts.length === 0 ? null : parts.join(' ')
  }
  return null
}

/**
 * 事件的可检索文本（memory.md §5 / data-storage.md §10）：
 * 只索引"有信息量"的事件；`turn_start/turn_end/state` 等纯边界事件不入索引。
 */
export function eventSearchText(kind: EventKind, payload: Readonly<Record<string, unknown>>): string | null {
  switch (kind) {
    case 'turn_start':
    case 'turn_end':
    case 'state':
      return null
    case 'message':
    case 'thought': {
      const direct = asText(payload['text'])
      if (direct !== null) return direct
      const content = payload['content']
      return typeof content === 'object' && content !== null ? asText((content as Record<string, unknown>)['text']) : null
    }
    case 'tool_call': {
      const name = asText(payload['tool']) ?? asText(payload['name']) ?? ''
      const args = asText(payload['args']) ?? ''
      const text = `${name} ${args}`.trim()
      return text.length === 0 ? null : text
    }
    case 'tool_result':
      return asText(payload['text']) ?? asText(payload['summary']) ?? asText(payload['result'])
    case 'plan': {
      const steps = payload['steps'] ?? payload['plan'] ?? payload['text']
      return asText(steps) ?? asText(payload['title'])
    }
    case 'summary':
      return asText(payload['digest']) ?? asText(payload['text'])
    case 'artifact':
      return [asText(payload['title']), asText(payload['summary'])].filter((part) => part !== null).join(' ') || null
    case 'approval_request':
    case 'approval_result':
      return [asText(payload['summary']), asText(payload['decision']), asText(payload['detail'])]
        .filter((part) => part !== null)
        .join(' ') || null
    case 'error':
      return asText(payload['message']) ?? asText(payload['errorCode'])
    default:
      return null
  }
}

/**
 * 关键词倒排索引（data-storage.md §10）：
 * - **派生投影**：`search-index/index.json` 可随时删除重建，业务状态以 log/记忆文件为准；
 * - **增量 sync**：按会话 `lastSeq` 与记忆条目 id 补齐（查询前同步，无需事件订阅）；
 * - **中文**：2-gram 主索引 + 汉字单字回退索引（零依赖）。
 */
export function createKeywordIndex(options: KeywordIndexOptions): SearchIndex {
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const cache = new Map<ProjectId, ProjectIndex>()

  const indexDir = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/search-index`
  const indexPath = (projectId: ProjectId): RelPath => `${indexDir(projectId)}/index.json`

  const addDoc = (index: ProjectIndex, refKey: string, doc: IndexedDoc): void => {
    index.docs.set(refKey, doc)
    const text = doc.text.slice(0, maxTextChars)
    for (const token of tokenize(text)) {
      const bucket = index.postings.get(token)
      if (bucket === undefined) index.postings.set(token, new Set([refKey]))
      else bucket.add(refKey)
    }
    for (const char of cjkChars(text)) {
      const bucket = index.charPostings.get(char)
      if (bucket === undefined) index.charPostings.set(char, new Set([refKey]))
      else bucket.add(refKey)
    }
  }

  const persist = async (projectId: ProjectId, index: ProjectIndex): Promise<void> => {
    const payload: PersistedIndex = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: index.builtAt,
      postings: Object.fromEntries([...index.postings].map(([token, refs]) => [token, [...refs]])),
      charPostings: Object.fromEntries([...index.charPostings].map(([char, refs]) => [char, [...refs]])),
      docs: Object.fromEntries(index.docs),
      indexedSeq: Object.fromEntries(index.indexedSeq),
      indexedMemoryIds: [...index.indexedMemoryIds],
    }
    await options.fileStore.writeJsonAtomic(indexPath(projectId), payload)
  }

  const load = async (projectId: ProjectId): Promise<ProjectIndex | null> => {
    const text = await options.fileStore.readText(indexPath(projectId))
    if (!text.ok) return null
    try {
      const parsed = JSON.parse(text.value) as PersistedIndex
      if (parsed.schemaVersion !== SCHEMA_VERSION) return null
      const index = emptyIndex()
      index.builtAt = typeof parsed.builtAt === 'string' ? parsed.builtAt : null
      for (const [token, refs] of Object.entries(parsed.postings ?? {})) index.postings.set(token, new Set(refs))
      for (const [char, refs] of Object.entries(parsed.charPostings ?? {})) index.charPostings.set(char, new Set(refs))
      for (const [refKey, doc] of Object.entries(parsed.docs ?? {})) index.docs.set(refKey, doc)
      for (const [sessionId, seq] of Object.entries(parsed.indexedSeq ?? {})) index.indexedSeq.set(sessionId, seq)
      for (const entryId of parsed.indexedMemoryIds ?? []) index.indexedMemoryIds.add(entryId)
      return index
    } catch {
      return null // 损坏 → 视为不存在，稍后重建（data-storage.md §9）
    }
  }

  /** 补齐某个项目的增量：新会话事件 + 新记忆条目 */
  const sync = async (projectId: ProjectId, index: ProjectIndex): Promise<void> => {
    const metas = await options.sessionMetaStore.list(projectId)
    if (metas.ok) {
      for (const meta of metas.value) {
        const indexed = index.indexedSeq.get(meta.id) ?? 0
        if (meta.lastSeq <= indexed) continue
        const window = await options.sessionLogStore.readWindow(projectId, meta.id, { fromSeq: indexed + 1 })
        if (!window.ok) continue
        for (const event of window.value) {
          const text = eventSearchText(event.kind, event.payload)
          if (text === null || text.trim().length === 0) continue
          addDoc(index, refKeyOfEvent(meta.id, event.seq), {
            scope: 'session',
            sessionId: meta.id,
            seq: event.seq,
            entryId: null,
            kind: event.kind,
            instanceId: ownerOfSession(meta.id),
            ts: event.ts,
            text,
          })
        }
        index.indexedSeq.set(meta.id, meta.lastSeq)
      }
    }

    const memories = await options.memoryStore.list(projectId)
    if (memories.ok) {
      for (const entry of memories.value) {
        if (index.indexedMemoryIds.has(entry.id)) continue
        addDoc(index, refKeyOfMemory(entry.id), {
          scope: 'memory',
          sessionId: null,
          seq: null,
          entryId: entry.id,
          kind: null,
          instanceId: entry.instanceId,
          ts: entry.ts,
          text: `${entry.content} ${entry.tags.join(' ')}`.trim(),
        })
        index.indexedMemoryIds.add(entry.id)
      }
    }
  }

  /** 查询/统计入口：内存命中即用；否则读盘；再否则（无盘/损坏）内存重建 */
  const ensureReady = async (projectId: ProjectId): Promise<ProjectIndex> => {
    let index = cache.get(projectId)
    if (index === undefined) {
      index = (await load(projectId)) ?? emptyIndex()
      cache.set(projectId, index)
    }
    await sync(projectId, index)
    return index
  }

  const statsOf = (index: ProjectIndex): SearchIndexStats => ({
    documents: index.docs.size,
    tokens: index.postings.size,
    builtAt: index.builtAt,
  })

  return {
    async rebuild(projectId): Promise<Result<SearchIndexStats>> {
      const index = emptyIndex()
      index.builtAt = options.clock.now().toISOString()
      cache.set(projectId, index)
      await sync(projectId, index)
      index.builtAt = options.clock.now().toISOString()
      await persist(projectId, index)
      return ok(statsOf(index))
    },

    async query(projectId, text, queryOptions?: SearchQueryOptions): Promise<Result<readonly SearchHit[]>> {
      const tokens = tokenize(text)
      if (tokens.length === 0) return ok([])
      const index = await ensureReady(projectId)

      const matched = new Map<string, { readonly tokens: string[]; score: number }>()
      for (const token of tokens) {
        for (const refKey of index.postings.get(token) ?? []) {
          const current = matched.get(refKey)
          if (current === undefined) matched.set(refKey, { tokens: [token], score: 1 })
          else current.tokens.push(token)
        }
      }
      for (const [refKey, entry] of matched) {
        matched.set(refKey, { tokens: entry.tokens, score: entry.tokens.length / tokens.length })
      }

      // 词元全不命中 → 汉字单字回退（仅针对单字查询，如"登"；长查询不放松，避免噪声命中）
      const charFallback = tokens.length === 1 && tokens[0]?.length === 1
      if (matched.size === 0 && charFallback) {
        const chars = cjkChars(text)
        if (chars.length === 0) return ok([])
        for (const char of chars) {
          for (const refKey of index.charPostings.get(char) ?? []) {
            const current = matched.get(refKey)
            if (current === undefined) matched.set(refKey, { tokens: [char], score: 1 })
            else current.tokens.push(char)
          }
        }
        for (const [refKey, entry] of matched) {
          matched.set(refKey, { tokens: entry.tokens, score: (entry.tokens.length / chars.length) * 0.5 })
        }
      }

      const scope = queryOptions?.scope ?? 'all'
      const hits: SearchHit[] = []
      for (const [refKey, entry] of matched) {
        const doc = index.docs.get(refKey)
        if (doc === undefined) continue
        if (scope !== 'all' && doc.scope !== scope) continue
        if (queryOptions?.sessionId !== undefined && doc.sessionId !== queryOptions.sessionId) continue
        hits.push({
          scope: doc.scope,
          sessionId: doc.sessionId,
          seq: doc.seq,
          entryId: doc.entryId,
          kind: doc.kind,
          text: snippetAround(doc.text, entry.tokens),
          score: Number(entry.score.toFixed(4)),
          tokens: entry.tokens,
        })
      }
      hits.sort((a, b) => b.score - a.score || (b.seq ?? 0) - (a.seq ?? 0) || (b.entryId ?? '').localeCompare(a.entryId ?? ''))
      return ok(hits.slice(0, queryOptions?.limit ?? DEFAULT_LIMIT))
    },

    async stats(projectId): Promise<Result<SearchIndexStats>> {
      const index = await ensureReady(projectId)
      return ok(statsOf(index))
    },
  }
}
