import type { Clock } from '../../ports/clock'
import type { ApprovalKind, ApprovalRecord, ApprovalStatus, ApprovalStore } from '../../ports/approval'
import type { EventBroadcaster } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { Logger } from '../../ports/logger'
import type { InstanceId, ProjectId } from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

export interface ApprovalServiceOptions {
  readonly store: ApprovalStore
  readonly broadcaster: EventBroadcaster
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly logger: Logger
  /**
   * 唤醒申请者（S47/D50）：**没有进程内等待者**时（典型是进程重启过——等待者随进程消失，
   * 见本文件"跨重启"口径），决定落盘后必须让申请者知道，否则用户点了"批准/拒绝"什么都不会发生，
   * 表现为"审批失效"。与询问答复的处理方式一致（question-service 也是这么做的）。
   */
  readonly notify: (input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly text: string
  }) => Promise<void>
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
      } else if (updated.value.status === 'approved' || updated.value.status === 'rejected') {
        // S47/D50：没有等待者（进程重启过，回合已不在）→ 主动唤醒申请者，别让"批准"石沉大海
        await options
          .notify({
            projectId,
            instanceId: updated.value.actor,
            text: `[审批] 你的申请已被${updated.value.status === 'approved' ? '批准' : '拒绝'}：${updated.value.summary}。请据此继续；若该动作已不再需要，忽略本条即可。`,
          })
          .catch((cause: unknown) => {
            options.logger.warn('审批决定唤醒申请者失败', { projectId, approvalId, message: String(cause) })
          })
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
