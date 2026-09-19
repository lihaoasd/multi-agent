/**
 * 输入框上方的"待处理项"只列**当前会话**的（S45/D48）。
 *
 * 起因（用户口径）："谁的发出的审批，应该显示在谁的窗口下面"。
 * 审批卡原先直接渲染 `GET /approvals?status=pending` 的**项目全量**——于是 A 角色申请的命令审批，
 * 会出现在 B 角色的会话窗口里（右栏的项目级列表才是"全局视角"，位置不变）。
 * 询问卡 S32 起就是按会话过滤的，这里把两者统一到同一个纯函数，避免再走偏。
 *
 * 纯函数、node 侧可单测（沿用 S23/S26/S28/S33/S35/S37/S38/S39/S41/S42 的做法）。
 */

export interface SessionScoped {
  readonly sessionId: string
}

/** 只保留属于该会话的项；`sessionId` 为空（未选中会话）时返回空数组 */
export function pendingForSession<T extends SessionScoped>(
  items: readonly T[],
  sessionId: string | null,
): readonly T[] {
  if (sessionId === null || sessionId.length === 0) return []
  return items.filter((item) => item.sessionId === sessionId)
}
