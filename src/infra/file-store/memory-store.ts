import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type {
  MemoryEntry,
  MemoryListFilter,
  MemoryScope,
  MemoryStore,
} from '../../ports/memory'
import { MEMORY_TYPES } from '../../ports/memory'
import type { InstanceId, ProjectId } from '../../ports/project'
import { err, ok } from '../../shared/result'

export interface MemoryStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

/** 记忆文件为 append-only：同 id 的后续行是状态变更（supersede），读取时取最后一条 */
function parseEntry(raw: unknown): MemoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const content = typeof record['content'] === 'string' ? record['content'] : ''
  if (id.length === 0 || content.length === 0) return null

  const type = record['type']
  const scope = record['scope']
  const state = record['state']
  const source = record['source']
  const sourceRecord = typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {}
  const instanceId = typeof record['instanceId'] === 'string' ? record['instanceId'] : null

  return {
    id,
    ts: typeof record['ts'] === 'string' ? record['ts'] : '',
    scope: scope === 'global' ? 'global' : 'agent',
    instanceId: instanceId !== null && instanceId.length > 0 ? instanceId : null,
    type: (MEMORY_TYPES as readonly string[]).includes(type as string) ? (type as MemoryEntry['type']) : 'fact',
    content,
    source: {
      sessionId: typeof sourceRecord['sessionId'] === 'string' ? sourceRecord['sessionId'] : '',
      seq: typeof sourceRecord['seq'] === 'number' && Number.isFinite(sourceRecord['seq']) ? sourceRecord['seq'] : 0,
    },
    tags: Array.isArray(record['tags']) ? record['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
    refs: Array.isArray(record['refs']) ? record['refs'].filter((ref): ref is string => typeof ref === 'string') : [],
    state: state === 'superseded' ? 'superseded' : 'active',
    supersededBy: typeof record['supersededBy'] === 'string' ? record['supersededBy'] : null,
  }
}

/**
 * L3 长期记忆存储（memory.md §4、data-storage.md §5）：
 * `projects/<pid>/memories/global.jsonl`（项目共享）与 `<instanceId>.jsonl`（角色个人）。
 */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const { fileStore, lock } = options
  const dirFor = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/memories`
  const pathFor = (projectId: ProjectId, scope: MemoryScope, instanceId: InstanceId | null): RelPath =>
    `${dirFor(projectId)}/${scope === 'global' ? 'global' : (instanceId ?? '_unknown')}.jsonl`

  const readFile = async (path: RelPath): Promise<readonly MemoryEntry[]> => {
    const text = await fileStore.readText(path)
    if (!text.ok) return []
    const merged = new Map<string, MemoryEntry>()
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseEntry(JSON.parse(trimmed))
        if (parsed !== null) merged.set(parsed.id, parsed)
      } catch {
        // 坏行跳过（data-storage.md §9 容错口径）
      }
    }
    return [...merged.values()]
  }

  /** 读取范围：global / 单个角色 / 全部（默认） */
  const readScope = async (
    projectId: ProjectId,
    filter: MemoryListFilter | undefined,
  ): Promise<readonly MemoryEntry[]> => {
    if (filter?.scope === 'global') return readFile(pathFor(projectId, 'global', null))
    if (filter?.scope === 'agent') {
      if (filter.instanceId !== undefined) return readFile(pathFor(projectId, 'agent', filter.instanceId))
      const listed = await fileStore.list(dirFor(projectId))
      if (!listed.ok) return []
      const files = listed.value
        .filter((entry) => entry.isDirectory === false && entry.name.endsWith('.jsonl') && entry.name !== 'global.jsonl')
        .map((entry) => `${dirFor(projectId)}/${entry.name}`)
      const grouped = await Promise.all(files.map((path) => readFile(path)))
      return grouped.flat()
    }
    const listed = await fileStore.list(dirFor(projectId))
    if (!listed.ok) return []
    const files = listed.value
      .filter((entry) => entry.isDirectory === false && entry.name.endsWith('.jsonl'))
      .map((entry) => `${dirFor(projectId)}/${entry.name}`)
    const grouped = await Promise.all(files.map((path) => readFile(path)))
    return grouped.flat()
  }

  const sortDesc = (entries: readonly MemoryEntry[]): readonly MemoryEntry[] =>
    [...entries].sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))

  return {
    async append(projectId, entry) {
      if (entry.content.trim().length === 0) {
        return err('ERR_VALIDATION', '记忆内容不能为空')
      }
      if (entry.scope === 'agent' && (entry.instanceId === null || entry.instanceId.length === 0)) {
        return err('ERR_VALIDATION', '角色记忆必须带 instanceId')
      }
      const path = pathFor(projectId, entry.scope, entry.instanceId)
      return lock.withLock(`memory:${path}`, async () => {
        const appended = await fileStore.appendLine(path, JSON.stringify(entry))
        return appended.ok ? ok(entry) : appended
      })
    },

    async list(projectId, filter) {
      let entries = [...(await readScope(projectId, filter))]
      if (filter?.instanceId !== undefined) entries = entries.filter((item) => item.instanceId === filter.instanceId)
      if (filter?.type !== undefined) entries = entries.filter((item) => item.type === filter.type)
      if (filter?.state !== undefined) entries = entries.filter((item) => item.state === filter.state)
      const sorted = sortDesc(entries)
      return ok(filter?.limit === undefined ? sorted : sorted.slice(0, filter.limit))
    },

    async get(projectId, entryId) {
      const found = (await readScope(projectId, undefined)).find((item) => item.id === entryId)
      return found === undefined ? err('ERR_NOT_FOUND', `记忆条目不存在：${entryId}`, { entryId }) : ok(found)
    },

    async supersede(projectId, entryId, supersededBy) {
      const current = (await readScope(projectId, undefined)).find((item) => item.id === entryId)
      if (current === undefined) {
        return err('ERR_NOT_FOUND', `记忆条目不存在：${entryId}`, { entryId })
      }
      if (current.state === 'superseded') {
        return err('ERR_CONFLICT', `记忆条目已被取代：${entryId}`, { entryId, supersededBy: current.supersededBy })
      }
      const updated: MemoryEntry = { ...current, state: 'superseded', supersededBy }
      const path = pathFor(projectId, current.scope, current.instanceId)
      return lock.withLock(`memory:${path}`, async () => {
        const appended = await fileStore.appendLine(path, JSON.stringify(updated))
        return appended.ok ? ok(updated) : appended
      })
    },

    async activeFor(projectId, input) {
      const all = await readScope(projectId, undefined)
      const active = all.filter((entry) => entry.state === 'active')
      const global = sortDesc(active.filter((entry) => entry.scope === 'global')).slice(0, input.globalLimit)
      const role = sortDesc(
        active.filter((entry) => entry.scope === 'agent' && entry.instanceId === input.instanceId),
      ).slice(0, input.roleLimit)
      return ok([...global, ...role])
    },
  }
}
