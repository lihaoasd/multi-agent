/**
 * 中文/英文关键词检索（M5，MVP）。
 * 索引：倒排 postings token→引用键；中文 2-gram + 英文字词（data-storage §10）。
 * 范围为项目全局（跨会话+记忆），结果按 会话/记忆 分组并给上下文片段。
 * 可见性（D18-②）：本文件为读取侧工具，是否可见由调用方（用户=全量；Agent=可检索集）决定。
 */
import type { ProjectStore } from '../../infra/store/project-store.js'
import type { SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'

export interface SearchHit {
  kind: 'session' | 'memory'
  refId: string
  sessionId?: string
  seq?: number
  snippet: string
}

export interface SearchResult {
  q: string
  sessions: Array<{ sessionId: string; hits: SearchHit[] }>
  memories: SearchHit[]
}

/** 索引文件的项目相对路径。 */
const INDEX_FILE = 'search-index/idx.json'

export class SearchService {
  constructor(
    private readonly store: ProjectStore,
    private readonly sessionStore: SessionStore,
  ) {}

  /** 切词：中文二元组 + 英文小写词（>=2 字符）。 */
  tokenize(text: string): string[] {
    const out = new Set<string>()
    const latin = text.match(/[a-zA-Z0-9_]{2,}/g) ?? []
    for (const w of latin) out.add(w.toLowerCase())
    const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
    for (const seg of cjk) {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
      if (seg.length === 1) out.add(seg)
    }
    return [...out]
  }

  /** 扫描全部 user/meeting 会话日志与记忆文件，构建/刷新倒排索引（派生数据可重建）。 */
  async rebuildIndex(projectId: string): Promise<void> {
    const postings = new Map<string, SearchHit[]>()
    const add = (token: string, hit: SearchHit) => {
      const list = postings.get(token) ?? []
      list.push(hit)
      postings.set(token, list)
    }
    const sessionIds = await this.sessionStore.listSessionIds(projectId)
    for (const sid of sessionIds) {
      const events = await this.sessionStore.readWindow(projectId, sid, { limit: 100000 })
      for (const evt of events) {
        const text = evtText(evt)
        if (!text) continue
        for (const t of this.tokenize(text))
          add(t, {
            kind: 'session',
            refId: `${sid}:${evt.seq}`,
            sessionId: sid,
            seq: evt.seq,
            snippet: text.slice(0, 300),
          })
      }
    }
    // 记忆：每个角色一份 JSONL，统一走门面读取（坏行由存储层跳过）
    for (const f of await this.store.list(projectId, 'memories')) {
      for (const e of await this.store.readAll<{ id: string; content: string }>(
        projectId,
        `memories/${f}`,
      )) {
        if (!e?.content) continue
        for (const t of this.tokenize(e.content))
          add(t, { kind: 'memory', refId: e.id, snippet: e.content.slice(0, 300) })
      }
    }
    const obj: Record<string, SearchHit[]> = {}
    for (const [k, v] of postings) obj[k] = v
    await this.store.writeText(projectId, INDEX_FILE, JSON.stringify(obj))
  }

  /** 查询：索引缺失自动重建（可再生）；结果按分组返回。 */
  async search(projectId: string, q: string): Promise<SearchResult> {
    const tokens = this.tokenize(q)
    const index = await this.readIndex(projectId)
    if (!index || Object.keys(index).length === 0) {
      await this.rebuildIndex(projectId)
    }
    const fresh = (await this.readIndex(projectId)) ?? {}
    // 交集取 token 最少命中的集合，避免 OR 噪音
    let pool: SearchHit[] | null = null
    for (const t of tokens) {
      const hits = fresh[t] ?? []
      if (pool === null || hits.length < pool.length) pool = hits
    }
    const hits = pool ?? []
    const sessionsMap = new Map<string, SearchHit[]>()
    const memories: SearchHit[] = []
    for (const h of hits) {
      if (h.kind === 'session' && h.sessionId) {
        const arr = sessionsMap.get(h.sessionId) ?? []
        arr.push(h)
        sessionsMap.set(h.sessionId, arr)
      } else if (h.kind === 'memory') {
        memories.push(h)
      }
    }
    return {
      q,
      sessions: [...sessionsMap.entries()].map(([sessionId, hs]) => ({
        sessionId,
        hits: hs.slice(0, 10),
      })),
      memories: memories.slice(0, 10),
    }
  }

  /** 读索引（可能不存在 → null；内容损坏时按"缺失"处理并触发重建）。 */
  private async readIndex(projectId: string): Promise<Record<string, SearchHit[]> | null> {
    const raw = await this.store.readText(projectId, INDEX_FILE)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as Record<string, SearchHit[]>
    } catch {
      return null
    }
  }
}

function evtText(evt: SessionLogEvent): string {
  if (evt.content?.text) return evt.content.text
  if (evt.kind === 'thought') return evt.content?.text ?? ''
  return ''
}
