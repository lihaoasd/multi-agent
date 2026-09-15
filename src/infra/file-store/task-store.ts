import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { ProjectId } from '../../ports/project'
import type { TaskListFilter, TaskRecord, TaskStore } from '../../ports/task'
import { TASK_STATES } from '../../shared/artifacts'
import { err, ok } from '../../shared/result'

export interface TaskStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

function parseTask(raw: unknown): TaskRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const title = typeof record['title'] === 'string' ? record['title'] : ''
  if (id.length === 0 || title.length === 0) return null
  const state = record['state']
  return {
    id,
    title,
    desc: typeof record['desc'] === 'string' ? record['desc'] : '',
    creator: typeof record['creator'] === 'string' ? record['creator'] : 'user',
    assignee: typeof record['assignee'] === 'string' ? record['assignee'] : '',
    state: (TASK_STATES as readonly string[]).includes(state as string) ? (state as TaskRecord['state']) : 'todo',
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    artifactIds: Array.isArray(record['artifactIds'])
      ? record['artifactIds'].filter((item): item is string => typeof item === 'string')
      : [],
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
    note: typeof record['note'] === 'string' ? record['note'] : null,
  }
}

/**
 * 任务存储（data-storage.md §7）：`tasks.jsonl` **append-only**，状态变更追加同 id 新行，读取取最后一条。
 * ⚠️ 设计原文写的是"读全量→改→覆盖写 + 单项目串行锁"；本轮改用 append-only（崩溃不产生半更新，
 * 与 approvals/memories 同构），进程内以 `tasks:<pid>` 锁串行化（实现口径，已回写 data-storage.md）。
 */
export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const { fileStore, lock } = options
  const pathFor = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/tasks.jsonl`

  const readAll = async (projectId: ProjectId): Promise<readonly TaskRecord[]> => {
    const text = await fileStore.readText(pathFor(projectId))
    if (!text.ok) return []
    const merged = new Map<string, TaskRecord>()
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseTask(JSON.parse(trimmed))
        if (parsed !== null) merged.set(parsed.id, parsed)
      } catch {
        // 坏行跳过
      }
    }
    return [...merged.values()]
  }

  return {
    async create(projectId, record) {
      return lock.withLock(`tasks:${projectId}`, async () => {
        const appended = await fileStore.appendLine(pathFor(projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async update(projectId, record) {
      return lock.withLock(`tasks:${projectId}`, async () => {
        const appended = await fileStore.appendLine(pathFor(projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async list(projectId, filter?: TaskListFilter) {
      let tasks = [...(await readAll(projectId))]
      if (filter?.state !== undefined) tasks = tasks.filter((item) => item.state === filter.state)
      if (filter?.assignee !== undefined) tasks = tasks.filter((item) => item.assignee === filter.assignee)
      if (filter?.creator !== undefined) tasks = tasks.filter((item) => item.creator === filter.creator)
      tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return ok(filter?.limit === undefined ? tasks : tasks.slice(0, filter.limit))
    },

    async get(projectId, taskId) {
      const found = (await readAll(projectId)).find((item) => item.id === taskId)
      return found === undefined ? err('ERR_NOT_FOUND', `任务不存在：${taskId}`, { taskId }) : ok(found)
    },
  }
}
