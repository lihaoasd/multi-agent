/**
 * 审批状态机（纯函数，domain 层；P2 归位，2026-09-14）。
 *
 * 迁移前规则内联在 `ApprovalService.decide` / `expirePending`：
 *   · pending 可被决定为 approved / rejected
 *   · pending 可被"入会搁置"作废为 expired
 *   · 一旦离开 pending 即**终态**（不可再批准/拒绝）——`decide` 的守卫正是这条
 *
 * 本文件只做判定与目标态计算，不涉及 IO、不产生时间戳（`decidedAt` 由 service 注入）。
 */

/** 审批状态（pending 之外的三种都是终态）。 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** 是否可被决定（只有 pending 可）。 */
export function isDecidableApproval(status: ApprovalStatus): boolean {
  return status === 'pending'
}

/**
 * 决定的守卫文本：允许返回 null，否则返回**与既有实现逐字一致**的拒绝原因
 * （由 service 包成 AppError，保持 REST 文案不变）。
 */
export function approvalDecideError(status: ApprovalStatus, approvalId: string): string | null {
  if (isDecidableApproval(status)) return null
  return `审批已处理（${status}）: ${approvalId}`
}
