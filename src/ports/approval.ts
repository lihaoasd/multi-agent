import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'

/**
 * 审批端口（真源：docs/design/sandbox.md §5、data-storage.md §7、agent-runtime.md §7）。
 * 跨重启口径（M1 定稿）：审批记录保持 `pending`；用户决定落盘但**不自动回放**原动作；
 * Agent 下次被触发时读取决定并自行决定是否重试（重试命中审批则需重新审批）。
 */

export type ApprovalKind = 'command' | 'submit' | 'rollback'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRecord {
  readonly id: string
  readonly projectId: ProjectId
  readonly kind: ApprovalKind
  readonly actor: InstanceId
  readonly sessionId: string
  readonly summary: string
  readonly detail: string
  /** doc 类提交的只读预览引用（D16-⑥，S6 落地内容） */
  readonly previewRef: string | null
  readonly status: ApprovalStatus
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly reason: string | null
}

export interface ApprovalStore {
  list(projectId: ProjectId, filter?: { readonly status?: ApprovalStatus; readonly actor?: InstanceId }): Promise<Result<readonly ApprovalRecord[]>>
  get(projectId: ProjectId, approvalId: string): Promise<Result<ApprovalRecord>>
  create(record: ApprovalRecord): Promise<Result<ApprovalRecord>>
  /** 决定只能落一次（pending → approved/rejected/expired） */
  decide(
    projectId: ProjectId,
    approvalId: string,
    decision: Exclude<ApprovalStatus, 'pending'>,
    reason?: string,
  ): Promise<Result<ApprovalRecord>>
  /** 某 Agent 是否有待处理审批（Agent 状态投影用：waiting） */
  hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean>
}
