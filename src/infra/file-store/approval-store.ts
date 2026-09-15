import type { ApprovalRecord, ApprovalStatus, ApprovalStore } from '../../ports/approval'
import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { InstanceId, ProjectId } from '../../ports/project'
import { err, ok } from '../../shared/result'

export interface ApprovalStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

function parseRecord(raw: unknown): ApprovalRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : ''
  if (id.length === 0 || projectId.length === 0) return null
  const kind = record['kind']
  const status = record['status']
  return {
    id,
    projectId,
    kind: kind === 'submit' || kind === 'rollback' ? kind : 'command',
    actor: typeof record['actor'] === 'string' ? record['actor'] : '',
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
    previewRef: typeof record['previewRef'] === 'string' ? record['previewRef'] : null,
    status: status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'pending',
    requestedAt: typeof record['requestedAt'] === 'string' ? record['requestedAt'] : '',
    decidedAt: typeof record['decidedAt'] === 'string' ? record['decidedAt'] : null,
    reason: typeof record['reason'] === 'string' ? record['reason'] : null,
  }
}

/**
 * 审批存储（`projects/<pid>/approvals.jsonl`）：**append-only**，状态变更追加新行，读取时同 id 取最后一条。
 * 这样崩溃不会产生"半更新"记录；跨重启 pending 保持不变（agent-runtime.md §7）。
 */
export function createApprovalStore(options: ApprovalStoreOptions): ApprovalStore {
  const { fileStore, lock, clock } = options
  const pathFor = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/approvals.jsonl`

  const readAll = async (projectId: ProjectId): Promise<readonly ApprovalRecord[]> => {
    const text = await fileStore.readText(pathFor(projectId))
    if (!text.ok) return []
    const merged = new Map<string, ApprovalRecord>()
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseRecord(JSON.parse(trimmed))
        if (parsed !== null) merged.set(parsed.id, parsed)
      } catch {
        // 坏行跳过
      }
    }
    return [...merged.values()]
  }

  return {
    async list(projectId, filter) {
      let records = [...(await readAll(projectId))]
      if (filter?.status !== undefined) records = records.filter((item) => item.status === filter.status)
      if (filter?.actor !== undefined) records = records.filter((item) => item.actor === filter.actor)
      records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      return ok(records)
    },

    async get(projectId, approvalId) {
      const found = (await readAll(projectId)).find((item) => item.id === approvalId)
      return found === undefined ? err('ERR_NOT_FOUND', `审批不存在：${approvalId}`, { approvalId }) : ok(found)
    },

    async create(record) {
      return lock.withLock(`approvals:${record.projectId}`, async () => {
        const appended = await fileStore.appendLine(pathFor(record.projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async decide(projectId, approvalId, decision: Exclude<ApprovalStatus, 'pending'>, reason) {
      return lock.withLock(`approvals:${projectId}`, async () => {
        const current = (await readAll(projectId)).find((item) => item.id === approvalId)
        if (current === undefined) {
          return err('ERR_NOT_FOUND', `审批不存在：${approvalId}`, { approvalId })
        }
        if (current.status !== 'pending') {
          return err('ERR_CONFLICT', `审批已处理（${current.status}），不能重复决定`, { approvalId })
        }
        const updated: ApprovalRecord = {
          ...current,
          status: decision,
          decidedAt: clock.now().toISOString(),
          reason: reason ?? null,
        }
        const appended = await fileStore.appendLine(pathFor(projectId), JSON.stringify(updated))
        return appended.ok ? ok(updated) : appended
      })
    },

    async hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean> {
      const records = await readAll(projectId)
      return records.some((item) => item.status === 'pending' && item.actor === instanceId)
    },
  }
}
