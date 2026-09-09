/**
 * 会话存储：meta.json + log.jsonl 的读写与恢复。
 * data-storage.md §4：meta 单 JSON、log append-only JSONL（先盘后推，事件模型 seq/turn/kind）。
 */
import { dirname, join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso } from '../../infra/util/id.js'
import { atomicWriteJson, readJson } from '../../infra/file-store/fs-utils.js'
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
  constructor(private readonly projectsRoot: string) {}

  private runtimeDir(projectId: string): string {
    return join(this.projectsRoot, projectId)
  }

  private metaFile(projectId: string, sessionId: string): string {
    return join(this.runtimeDir(projectId), 'sessions', `${sessionId}.meta.json`)
  }

  private logFile(projectId: string, sessionId: string): string {
    return join(this.runtimeDir(projectId), 'sessions', `${sessionId}.log.jsonl`)
  }

  async readMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
    const meta = await readJson<SessionMeta>(this.metaFile(projectId, sessionId))
    if (!meta) throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    return meta
  }

  async tryReadMeta(projectId: string, sessionId: string): Promise<SessionMeta | null> {
    return readJson<SessionMeta>(this.metaFile(projectId, sessionId))
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    const file = this.metaFile(meta.projectId, meta.id)
    await fs.mkdir(dirname(file), { recursive: true })
    await atomicWriteJson(file, meta)
  }

  /** 创建 user 会话 meta 骨架（幂等；已存在则直接返回）。供团队/向导使用。 */
  async ensureUserMeta(
    projectId: string,
    instanceId: string,
    agentName: string,
  ): Promise<SessionMeta> {
    const sessionId = `u_${instanceId}`
    const existing = await this.tryReadMeta(projectId, sessionId)
    if (existing) return existing
    const meta = buildUserSessionMeta(projectId, instanceId, agentName)
    await fs.mkdir(join(this.runtimeDir(projectId), 'sessions'), { recursive: true })
    await atomicWriteJson(this.metaFile(projectId, sessionId), meta)
    return meta
  }

  async listSessionIds(projectId: string): Promise<string[]> {
    const dir = join(this.runtimeDir(projectId), 'sessions')
    try {
      const names = await fs.readdir(dir)
      return names
        .filter((n) => n.endsWith('.meta.json'))
        .map((n) => n.slice(0, -'.meta.json'.length))
    } catch {
      return []
    }
  }

  /**
   * 追加事件（先盘后推 D18-⑤a）：log 落盘成功 = 事实生效；
   * meta.lastSeq 就地递增并同步落盘（投影，重启时按 log 尾部对账补齐）。
   * 注意：调用方持有的 meta 会被就地更新，连续追加时 seq 单调递增。
   */
  async appendEvent(
    meta: SessionMeta,
    event: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
  ): Promise<SessionLogEvent> {
    const seq = meta.lastSeq + 1
    const full: SessionLogEvent = {
      ...event,
      seq,
      ts: nowIso(),
      sessionId: meta.id,
    }
    const line = JSON.stringify(full)
    await fs.appendFile(this.logFile(meta.projectId, meta.id), line + '\n', 'utf8')
    meta.lastSeq = seq
    meta.updatedAt = full.ts
    // meta 投影写失败不阻断（重启对账）
    await this.writeMeta({ ...meta }).catch(() => undefined)
    return full
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
    const file = this.logFile(projectId, sessionId)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: SessionLogEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as SessionLogEvent)
      } catch {
        // 坏行跳过（损坏容错），M3 记 error 事件
      }
    }
    return out
  }

  /** 重建：meta.lastSeq 与 log 尾部对齐（缺失日志/meta 的恢复兜底）。 */
  async reconcileLastSeq(meta: SessionMeta): Promise<SessionMeta> {
    const all = await this.readLogLines(meta.projectId, meta.id)
    const maxSeq = all.length > 0 ? all[all.length - 1]!.seq : 0
    if (maxSeq !== meta.lastSeq) {
      const next = { ...meta, lastSeq: Math.max(maxSeq, meta.lastSeq) }
      await this.writeMeta(next)
      return next
    }
    return meta
  }
}

export type { MeetingSessionState, UserSessionState }
export { paths }
