import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { ProjectId } from '../../ports/project'
import {
  EMPTY_DISPATCHER_STATE,
  type DispatcherState,
  type DispatcherStateStore,
  type OccupancyEntry,
} from '../../ports/dispatcher'
import { err, ok, type Result } from '../../shared/result'

export interface DispatcherStateStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
      .map(([key, item]) => [key, Math.max(0, Math.floor(item as number))]),
  )
}

function asBooleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  )
}

function parseOccupancy(value: unknown): Record<string, OccupancyEntry> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, OccupancyEntry> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : ''
    if (sessionId.length === 0) continue
    result[key] = {
      type: record['type'] === 'task' ? 'task' : 'user',
      sessionId,
      since: typeof record['since'] === 'string' ? record['since'] : '',
    }
  }
  return result
}

export function parseDispatcherState(raw: unknown): Result<DispatcherState> {
  if (typeof raw !== 'object' || raw === null) return err('ERR_VALIDATION', 'runtime.state 不是对象')
  const record = raw as Record<string, unknown>
  if (record['schemaVersion'] !== 1) {
    return err('ERR_VALIDATION', 'runtime.state schemaVersion 不受支持', {
      schemaVersion: record['schemaVersion'],
    })
  }
  return ok({
    schemaVersion: 1,
    occupancy: parseOccupancy(record['occupancy']),
    lastHandledSeq: asNumberRecord(record['lastHandledSeq']),
    paused: asBooleanRecord(record['paused']),
    turns: asNumberRecord(record['turns']),
  })
}

/**
 * 运行期调度态存储（`projects/<pid>/runtime.state.json`）：
 * **occupancy 是运行期占用的唯一真相**（D18-④），其余字段（游标/暂停/回合计数）同文件持久化。
 * 文件损坏 → 备份为 `.bak.json` 并按空状态启动（占用可从日志重建，不阻断服务）。
 */
export function createDispatcherStateStore(options: DispatcherStateStoreOptions): DispatcherStateStore {
  const { fileStore, lock, clock } = options
  const statePathFor = (projectId: ProjectId): RelPath =>
    `${options.dataDir}/projects/${projectId}/runtime.state.json`

  return {
    async load(projectId: ProjectId): Promise<Result<DispatcherState>> {
      const path = statePathFor(projectId)
      const text = await fileStore.readText(path)
      if (!text.ok) {
        return text.error.code === 'ERR_NOT_FOUND' ? ok(EMPTY_DISPATCHER_STATE) : text
      }
      try {
        const parsed = parseDispatcherState(JSON.parse(text.value))
        if (parsed.ok) return parsed
      } catch {
        // 落到下面的备份分支
      }
      const backupPath = `${path}.bak-${clock.now().toISOString().replace(/[:.]/g, '-')}.json`
      await fileStore.writeTextAtomic(backupPath, text.value)
      await fileStore.remove(path)
      return ok(EMPTY_DISPATCHER_STATE)
    },

    async save(projectId: ProjectId, state: DispatcherState): Promise<Result<DispatcherState>> {
      return lock.withLock(`dispatcher-state:${projectId}`, async () => {
        const written = await fileStore.writeJsonAtomic(statePathFor(projectId), state)
        return written.ok ? ok(state) : written
      })
    },
  }
}
