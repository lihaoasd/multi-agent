/**
 * 会话存储：meta.json + log.jsonl 的读写与恢复。
 * data-storage.md §4：meta 单 JSON、log append-only JSONL（先盘后推，事件模型 seq/turn/kind）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'
import type {
  MeetingSessionState,
  SessionLogEvent,
  SessionMeta,
  UserSessionState,
} from '../../shared/types/session.js'

export interface SessionFilePaths {
  projectRuntimeDir: string
  sessionId: string
}

function paths(projectRuntimeDir: string, sessionId: string): SessionFilePaths {
  return { projectRuntimeDir, sessionId }
}

/** 构造 user 会话 meta 骨架（纯函数；供团队创建与 store 共用同一形状）。 */
export function buildUserSessionMeta(
  projectId: string,
  instanceId: string,
  agentName: string,
  ts = nowIso(),
): SessionMeta {
  const sessionId = `u_${instanceId}`
  return {
    id: sessionId,
    type: 'user',
    projectId,
    participants: { user: true, agents: [instanceId] },
    host: null,
    state: 'active',
    agentDisplayName: agentName,
    agenda: null,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    lastSeq: 0,
    segments: [{ file: `${sessionId}.log.jsonl`, startSeq: 1, endSeq: 0 }],
    summaryRefs: [],
  }
}

export class SessionStore {
  /** 每会话写入串行队列：并发追加（回合/审批/产出物投影）不重号、meta 不回退。 */
  private readonly writeLocks = new Map<string, Promise<unknown>>()

  constructor(private readonly store: ProjectStore) {}

  private lockKey(projectId: string, sessionId: string): string {
    return `${projectId}:${sessionId}`
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const wrapped = run.then(
      () => undefined,
      () => undefined,
    )
    this.writeLocks.set(key, wrapped)
    try {
      return await run
    } finally {
      if (this.writeLocks.get(key) === wrapped) this.writeLocks.delete(key)
    }
  }

  /** 会话 meta 的项目相对路径。 */
  private metaRel(sessionId: string): string {
    return `sessions/${sessionId}.meta.json`
  }

  /** 会话日志的项目相对路径。 */
  private logRel(sessionId: string): string {
    return `sessions/${sessionId}.log.jsonl`
  }

  async readMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
    const meta = await this.tryReadMeta(projectId, sessionId)
    if (!meta) throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    return meta
  }

  async tryReadMeta(projectId: string, sessionId: string): Promise<SessionMeta | null> {
    return this.store.readJson<SessionMeta>(projectId, this.metaRel(sessionId))
  }

  /**
   * 写 meta 投影：与 appendEvent 共用同一把会话锁，并把 lastSeq 取"磁盘更大者"，避免
   * 服务层（会议状态、已读位点等）与并发追加互相覆盖（曾导致 close 后又被写回 open）。
   */
  async writeMeta(meta: SessionMeta): Promise<void> {
    await this.withLock(this.lockKey(meta.projectId, meta.id), async () => {
      const fresh = await this.tryReadMeta(meta.projectId, meta.id)
      const next: SessionMeta = { ...meta }
      if (fresh) next.lastSeq = Math.max(fresh.lastSeq ?? 0, meta.lastSeq ?? 0)
      await this.writeMetaUnlocked(next)
    })
  }

  private async writeMetaUnlocked(meta: SessionMeta): Promise<void> {
    await this.store.writeJson(meta.projectId, this.metaRel(meta.id), meta)
  }

  async listSessionIds(projectId: string): Promise<string[]> {
    const names = await this.store.list(projectId, 'sessions')
    return names
      .filter((n) => n.endsWith('.meta.json'))
      .map((n) => n.slice(0, -'.meta.json'.length))
  }

  /**
   * 追加事件（先盘后推 D18-⑤a）：log 落盘成功 = 事实生效。
   * seq 以磁盘 meta 为准（调用方可能持有过期 meta：并发追加者一律取 max(磁盘, 传入)），
   * 每会话串行，保证 seq 严格递增不重复；写完后把最新 meta 同步回调用方对象。
   */
  async appendEvent(
    meta: SessionMeta,
    event: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
  ): Promise<SessionLogEvent> {
    return this.withLock(this.lockKey(meta.projectId, meta.id), async () => {
      const fresh = await this.tryReadMeta(meta.projectId, meta.id)
      const base = fresh ?? meta
      const lastSeq = Math.max(meta.lastSeq, fresh?.lastSeq ?? 0)
      const seq = lastSeq + 1
      const full: SessionLogEvent = {
        ...event,
        seq,
        ts: nowIso(),
        sessionId: meta.id,
      }
      await this.store.append(meta.projectId, this.logRel(meta.id), full)
      Object.assign(base, { lastSeq: seq, updatedAt: full.ts })
      Object.assign(meta, base)
      // meta 投影写失败不阻断（重启对账）；已在锁内 → 用不加锁版本，避免自锁
      await this.writeMetaUnlocked({ ...base }).catch(() => undefined)
      return full
    })
  }

  /** 读会话窗口：fromSeq 起至多 limit 条（含 thought/tool，UI 可按 kind 过滤）。 */
  async readWindow(
    projectId: string,
    sessionId: string,
    opts: { fromSeq?: number; limit?: number } = {},
  ): Promise<SessionLogEvent[]> {
    await this.readMeta(projectId, sessionId)
    const from = opts.fromSeq ?? 1
    const limit = opts.limit ?? 200
    const all = await this.readLogLines(projectId, sessionId)
    return all.filter((e) => e.seq >= from).slice(-limit)
  }

  /** 读会话尾部 N 条（上下文窗口/恢复用）。 */
  async readTail(projectId: string, sessionId: string, n: number): Promise<SessionLogEvent[]> {
    const all = await this.readLogLines(projectId, sessionId)
    return all.slice(-n)
  }

  /** 容错逐行读 log（坏行跳过，data-storage §9）。 */
  private async readLogLines(projectId: string, sessionId: string): Promise<SessionLogEvent[]> {
    return this.store.readAll<SessionLogEvent>(projectId, this.logRel(sessionId))
  }
}

export type { MeetingSessionState, UserSessionState }
export { paths }
