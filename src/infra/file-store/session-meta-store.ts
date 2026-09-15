import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { ProjectId } from '../../ports/project'
import type { SessionId, SessionMeta, SessionMetaStore, SummaryRef } from '../../ports/session'
import { err, ok, type Result } from '../../shared/result'

export interface SessionMetaStoreOptions {
  readonly fileStore: FileStore
  readonly clock: Clock
  /** 数据根（默认 `data`）：会话文件在 `<dataDir>/projects/<pid>/sessions/` */
  readonly dataDir: RelPath
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseSegments(raw: unknown): readonly { file: string; startSeq: number; endSeq: number; lines: number }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const record = item as Record<string, unknown>
      const file = asString(record['file'])
      if (file.length === 0) return null
      return {
        file,
        startSeq: Math.max(0, Math.floor(Number(record['startSeq'] ?? 0)) || 0),
        endSeq: Math.max(0, Math.floor(Number(record['endSeq'] ?? 0)) || 0),
        lines: Math.max(0, Math.floor(Number(record['lines'] ?? 0)) || 0),
      }
    })
    .filter((item): item is { file: string; startSeq: number; endSeq: number; lines: number } => item !== null)
}

function parseSummaryRefs(raw: unknown): readonly SummaryRef[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const record = item as Record<string, unknown>
      const summaryId = asString(record['summaryId'])
      if (summaryId.length === 0) return null
      return {
        seq: Math.max(0, Math.floor(Number(record['seq'] ?? 0)) || 0),
        summaryId,
        ofSeq: Math.max(0, Math.floor(Number(record['ofSeq'] ?? 0)) || 0),
        toSeq: Math.max(0, Math.floor(Number(record['toSeq'] ?? 0)) || 0),
      }
    })
    .filter((item): item is SummaryRef => item !== null)
}

export function parseSessionMeta(raw: unknown): Result<SessionMeta> {
  if (typeof raw !== 'object' || raw === null) return err('ERR_VALIDATION', '会话 meta 不是对象')
  const record = raw as Record<string, unknown>
  const id = asString(record['id'])
  const projectId = asString(record['projectId'])
  if (id.length === 0 || projectId.length === 0) return err('ERR_VALIDATION', '会话 meta 缺少 id/projectId')
  const participants = typeof record['participants'] === 'object' && record['participants'] !== null
    ? (record['participants'] as Record<string, unknown>)
    : {}
  const agents = Array.isArray(participants['agents'])
    ? participants['agents'].filter((item): item is string => typeof item === 'string')
    : []
  const state = asString(record['state'], 'active')
  return ok({
    schemaVersion: 1,
    id,
    type: 'user',
    projectId,
    participants: { user: true, agents },
    state: state === 'suspended' || state === 'archived' ? state : 'active',
    createdAt: asString(record['createdAt']),
    updatedAt: asString(record['updatedAt']),
    closedAt: typeof record['closedAt'] === 'string' ? record['closedAt'] : null,
    lastSeq: Math.max(0, Math.floor(Number(record['lastSeq'] ?? 0)) || 0),
    segments: parseSegments(record['segments']),
    summaryRefs: parseSummaryRefs(record['summaryRefs']),
  })
}

/** 会话 meta 存储：`<dataDir>/projects/<pid>/sessions/<sid>.meta.json` */
export function createSessionMetaStore(options: SessionMetaStoreOptions): SessionMetaStore {
  const { fileStore, clock } = options
  const sessionsDir = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/sessions`
  const metaPath = (projectId: ProjectId, sessionId: SessionId): RelPath =>
    `${sessionsDir(projectId)}/${sessionId}.meta.json`

  const store: SessionMetaStore = {
    async list(projectId: ProjectId): Promise<Result<readonly SessionMeta[]>> {
      const listed = await fileStore.list(sessionsDir(projectId))
      if (!listed.ok) {
        return listed.error.code === 'ERR_NOT_FOUND' ? ok([]) : listed
      }
      const metas: SessionMeta[] = []
      for (const entry of listed.value) {
        if (entry.isDirectory || !entry.name.endsWith('.meta.json')) continue
        const text = await fileStore.readText(`${sessionsDir(projectId)}/${entry.name}`)
        if (!text.ok) continue
        try {
          const parsed = parseSessionMeta(JSON.parse(text.value))
          if (parsed.ok) metas.push(parsed.value)
        } catch {
          // 坏 meta 跳过：不让单个文件毁掉会话列表
        }
      }
      metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return ok(metas)
    },

    async get(projectId: ProjectId, sessionId: SessionId): Promise<Result<SessionMeta>> {
      const text = await fileStore.readText(metaPath(projectId, sessionId))
      if (!text.ok) {
        return text.error.code === 'ERR_NOT_FOUND'
          ? err('ERR_NOT_FOUND', '会话不存在', { projectId, sessionId })
          : text
      }
      try {
        return parseSessionMeta(JSON.parse(text.value))
      } catch {
        return err('ERR_VALIDATION', '会话 meta 解析失败', { projectId, sessionId })
      }
    },

    async create(meta: SessionMeta): Promise<Result<SessionMeta>> {
      const path = metaPath(meta.projectId, meta.id)
      if (await fileStore.exists(path)) {
        return err('ERR_CONFLICT', '会话已存在', { sessionId: meta.id })
      }
      const stamped: SessionMeta = { ...meta, schemaVersion: 1, updatedAt: meta.updatedAt || clock.now().toISOString() }
      const written = await fileStore.writeJsonAtomic(path, stamped)
      return written.ok ? ok(stamped) : written
    },

    async update(
      projectId: ProjectId,
      sessionId: SessionId,
      mutate: (meta: SessionMeta) => Result<SessionMeta>,
    ): Promise<Result<SessionMeta>> {
      const current = await store.get(projectId, sessionId)
      if (!current.ok) return current
      const next = mutate(current.value)
      if (!next.ok) return next
      const stamped: SessionMeta = { ...next.value, updatedAt: clock.now().toISOString() }
      const written = await fileStore.writeJsonAtomic(metaPath(projectId, sessionId), stamped)
      return written.ok ? ok(stamped) : written
    },
  }

  return store
}
