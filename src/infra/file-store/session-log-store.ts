import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { ProjectId } from '../../ports/project'
import type {
  EventKind,
  NewEvent,
  ReadWindowOptions,
  SegmentRef,
  SessionId,
  SessionLogStore,
  SessionMetaStore,
  StoredEvent,
} from '../../ports/session'
import { err, ok, type Result } from '../../shared/result'

export interface SessionLogStoreOptions {
  readonly fileStore: FileStore
  readonly metaStore: SessionMetaStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
  /** 单段行数上限（超过即轮转；设计 §9 默认 5 万行） */
  readonly maxLinesPerSegment?: number
}

const DEFAULT_MAX_LINES = 50_000

function serialize(sessionId: SessionId, event: StoredEvent): string {
  return JSON.stringify({
    seq: event.seq,
    ts: event.ts,
    sessionId,
    turn: event.turn,
    kind: event.kind,
    ...event.payload,
  })
}

function deserialize(sessionId: SessionId, line: string): StoredEvent | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const seq = Number(record['seq'])
    const kind = record['kind']
    if (!Number.isFinite(seq) || typeof kind !== 'string') return null
    const { seq: _seq, ts, sessionId: _sid, turn, kind: _kind, ...payload } = record
    return {
      seq: Math.floor(seq),
      ts: typeof ts === 'string' ? ts : '',
      sessionId,
      turn: Math.max(0, Math.floor(Number(turn ?? 0)) || 0),
      kind: kind as EventKind,
      payload,
    }
  } catch {
    return null // 逐行容错：坏行跳过（data-storage §9）
  }
}

/**
 * 会话日志存储（data-storage.md §4.2/§9）：
 * - 追加时**分配连续 seq** 并更新 meta（`lastSeq` 与 `segments`），全程在 `session:<id>` 锁内；
 * - 逐行容错读取（坏行跳过）；`limit` 为**尾窗**语义（取最近 N 条）；
 * - 超阈值轮转：把当前段改名为 `.log.<n>.jsonl`，**seq 跨段仍单调连续**（M3）。
 */
export function createSessionLogStore(options: SessionLogStoreOptions): SessionLogStore {
  const { fileStore, metaStore, lock, clock } = options
  const maxLines = options.maxLinesPerSegment ?? DEFAULT_MAX_LINES

  const sessionsDir = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/sessions`
  const segmentFile = (sessionId: SessionId, index: number): RelPath =>
    index === 0 ? `${sessionId}.log.jsonl` : `${sessionId}.log.${index}.jsonl`

  const readEventsFromSegments = async (
    projectId: ProjectId,
    sessionId: SessionId,
    segments: readonly SegmentRef[],
    fromSeq: number,
  ): Promise<readonly StoredEvent[]> => {
    const events: StoredEvent[] = []
    for (const segment of segments) {
      const text = await fileStore.readText(`${sessionsDir(projectId)}/${segment.file}`)
      if (!text.ok) continue
      for (const line of text.value.split(/\r?\n/)) {
        const event = deserialize(sessionId, line)
        if (event === null) continue
        if (event.seq >= fromSeq) events.push(event)
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    return events
  }

  /** 轮转的**无锁**实现：调用方必须已持有 `session:<id>` 锁（KeyedLock 不可重入） */
  const rotateLocked = async (
    projectId: ProjectId,
    sessionId: SessionId,
    segments: readonly SegmentRef[],
    maxLinesPerSegment: number,
  ): Promise<Result<readonly SegmentRef[]>> => {
    const currentIndex = segments.length - 1
    const current = segments[currentIndex]
    if (current === undefined || current.lines < maxLinesPerSegment) return ok(segments)

    const archivedFile = segmentFile(sessionId, segments.length)
    const moved = await fileStore.move(
      `${sessionsDir(projectId)}/${current.file}`,
      `${sessionsDir(projectId)}/${archivedFile}`,
    )
    if (!moved.ok) return moved

    const next = [...segments]
    next[currentIndex] = { ...current, file: archivedFile }
    next.push({ file: segmentFile(sessionId, 0), startSeq: current.endSeq + 1, endSeq: current.endSeq, lines: 0 })
    return ok(next)
  }

  const store: SessionLogStore = {
    async append(
      projectId: ProjectId,
      sessionId: SessionId,
      events: readonly NewEvent[],
    ): Promise<Result<readonly StoredEvent[]>> {
      if (events.length === 0) return ok([])
      return lock.withLock(`session:${sessionId}`, async () => {
        const meta = await metaStore.get(projectId, sessionId)
        if (!meta.ok) return meta

        const segments = [...meta.value.segments]
        if (segments.length === 0) {
          segments.push({ file: segmentFile(sessionId, 0), startSeq: 1, endSeq: 0, lines: 0 })
        }

        const base = meta.value.lastSeq
        const stored: StoredEvent[] = events.map((event, index) => ({
          seq: base + index + 1,
          ts: event.ts ?? clock.now().toISOString(),
          sessionId,
          turn: event.turn,
          kind: event.kind,
          payload: event.payload,
        }))

        const currentIndex = segments.length - 1
        const current = segments[currentIndex]
        if (current === undefined) return err('ERR_INTERNAL', '会话分段表异常', { sessionId })

        for (const event of stored) {
          const appended = await fileStore.appendLine(
            `${sessionsDir(projectId)}/${current.file}`,
            serialize(sessionId, event),
          )
          if (!appended.ok) return appended
        }

        const nextSegments: SegmentRef[] = segments.map((segment, index) =>
          index === currentIndex
            ? {
                ...segment,
                startSeq: segment.lines === 0 ? stored[0]?.seq ?? segment.startSeq : segment.startSeq,
                endSeq: stored[stored.length - 1]?.seq ?? segment.endSeq,
                lines: segment.lines + stored.length,
              }
            : segment,
        )

        // 超阈值则先轮转，再一次性写 meta（避免两次写入与不可重入锁）
        const rotated = await rotateLocked(projectId, sessionId, nextSegments, maxLines)
        if (!rotated.ok) return rotated

        const updated = await metaStore.update(projectId, sessionId, (value) => ({
          ok: true,
          value: { ...value, lastSeq: stored[stored.length - 1]?.seq ?? base, segments: rotated.value },
        }))
        if (!updated.ok) return updated
        return ok(stored)
      })
    },

    async readWindow(
      projectId: ProjectId,
      sessionId: SessionId,
      opts?: ReadWindowOptions,
    ): Promise<Result<readonly StoredEvent[]>> {
      const meta = await metaStore.get(projectId, sessionId)
      if (!meta.ok) return meta.error.code === 'ERR_NOT_FOUND' ? ok([]) : meta
      const all = await readEventsFromSegments(projectId, sessionId, meta.value.segments, opts?.fromSeq ?? 0)
      const limit = opts?.limit
      return ok(limit === undefined || limit >= all.length ? all : all.slice(all.length - limit))
    },

    async readKinds(
      projectId: ProjectId,
      sessionId: SessionId,
      kinds: readonly EventKind[],
      opts?: ReadWindowOptions,
    ): Promise<Result<readonly StoredEvent[]>> {
      const window = await store.readWindow(projectId, sessionId, opts)
      if (!window.ok) return window
      const wanted = new Set(kinds)
      return ok(window.value.filter((event) => wanted.has(event.kind)))
    },

    async lastSeq(projectId: ProjectId, sessionId: SessionId): Promise<number> {
      const meta = await metaStore.get(projectId, sessionId)
      return meta.ok ? meta.value.lastSeq : 0
    },

    async rotate(
      projectId: ProjectId,
      sessionId: SessionId,
      maxLinesPerSegment: number,
    ): Promise<Result<readonly SegmentRef[]>> {
      return lock.withLock(`session:${sessionId}`, async () => {
        const meta = await metaStore.get(projectId, sessionId)
        if (!meta.ok) return meta
        const rotated = await rotateLocked(projectId, sessionId, meta.value.segments, maxLinesPerSegment)
        if (!rotated.ok) return rotated
        if (rotated.value === meta.value.segments) return ok(rotated.value)
        const updated = await metaStore.update(projectId, sessionId, (value) => ({
          ok: true,
          value: { ...value, segments: rotated.value },
        }))
        return updated.ok ? ok(rotated.value) : updated
      })
    },
  }

  return store
}
