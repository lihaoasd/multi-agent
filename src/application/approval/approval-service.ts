import type { Clock } from '../../ports/clock'
import type { ApprovalKind, ApprovalRecord, ApprovalStatus, ApprovalStore } from '../../ports/approval'
import type { EventBroadcaster } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { InstanceId, ProjectId } from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

export interface ApprovalServiceOptions {
  readonly store: ApprovalStore
  readonly broadcaster: EventBroadcaster
  readonly ids: IdGenerator
  readonly clock: Clock
}

export interface ApprovalRequestInput {
  readonly projectId: ProjectId
  readonly kind: ApprovalKind
  readonly actor: InstanceId
  readonly sessionId: string
  readonly summary: string
  readonly detail: string
  readonly previewRef?: string
}

export interface ApprovalService {
  request(input: ApprovalRequestInput): Promise<Result<ApprovalRecord>>
  decide(
    projectId: ProjectId,
    approvalId: string,
    decision: Exclude<ApprovalStatus, 'pending'>,
    reason?: string,
  ): Promise<Result<ApprovalRecord>>
  list(
    projectId: ProjectId,
    filter?: { readonly status?: ApprovalStatus; readonly actor?: InstanceId },
  ): Promise<Result<readonly ApprovalRecord[]>>
  hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean>
  /** 等待用户决定（进程内）；用户停止/回合取消由 signal 打断 */
  waitForDecision(
    projectId: ProjectId,
    approvalId: string,
    signal: AbortSignal,
  ): Promise<Result<'approved' | 'rejected'>>
}

/**
 * 审批服务（sandbox.md §5、M1 跨重启口径）：
 * - 请求 → 落盘 pending + 广播 `approval.requested` + 注册进程内等待者；
 * - 决定 → 落盘（append-only）+ 唤醒等待者 + 广播 `approval.decided`；
 * - **跨重启**：pending 保持，等待者消失（回合视为未完成），决定落盘但**不回放**原动作。
 */
export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const { store, broadcaster, ids, clock } = options
  const waiters = new Map<string, (decision: 'approved' | 'rejected') => void>()

  const key = (projectId: string, approvalId: string): string => `${projectId}:${approvalId}`

  return {
    async request(input: ApprovalRequestInput): Promise<Result<ApprovalRecord>> {
      const record: ApprovalRecord = {
        id: ids.next('ap'),
        projectId: input.projectId,
        kind: input.kind,
        actor: input.actor,
        sessionId: input.sessionId,
        summary: input.summary,
        detail: input.detail,
        previewRef: input.previewRef ?? null,
        status: 'pending',
        requestedAt: clock.now().toISOString(),
        decidedAt: null,
        reason: null,
      }
      const created = await store.create(record)
      if (!created.ok) return created
      broadcaster.broadcast({
        type: 'approval.requested',
        payload: { projectId: record.projectId, approval: record },
      })
      return created
    },

    async decide(projectId, approvalId, decision, reason): Promise<Result<ApprovalRecord>> {
      const updated = await store.decide(projectId, approvalId, decision, reason)
      if (!updated.ok) return updated
      const waiter = waiters.get(key(projectId, approvalId))
      if (waiter !== undefined) {
        waiters.delete(key(projectId, approvalId))
        if (updated.value.status === 'approved' || updated.value.status === 'rejected') {
          waiter(updated.value.status)
        }
      }
      broadcaster.broadcast({
        type: 'approval.decided',
        payload: { projectId, approval: updated.value },
      })
      return updated
    },

    async list(projectId, filter): Promise<Result<readonly ApprovalRecord[]>> {
      return store.list(projectId, filter)
    },

    async hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean> {
      return store.hasPending(projectId, instanceId)
    },

    async waitForDecision(
      projectId: ProjectId,
      approvalId: string,
      signal: AbortSignal,
    ): Promise<Result<'approved' | 'rejected'>> {
      // 决定可能已经落盘（例如用户先点了再进入等待）：先查一次，避免永远挂住
      const current = await store.get(projectId, approvalId)
      if (current.ok && current.value.status !== 'pending') {
        return current.value.status === 'expired'
          ? err('ERR_APPROVAL_REJECTED', '审批已过期', { approvalId })
          : ok(current.value.status)
      }

      return new Promise<Result<'approved' | 'rejected'>>((resolvePromise) => {
        const settle = (decision: 'approved' | 'rejected'): void => {
          signal.removeEventListener('abort', onAbort)
          resolvePromise(ok(decision))
        }
        const onAbort = (): void => {
          waiters.delete(key(projectId, approvalId))
          resolvePromise(err('ERR_APPROVAL_REJECTED', '回合被取消，审批等待结束', { approvalId }))
        }
        waiters.set(key(projectId, approvalId), settle)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}
