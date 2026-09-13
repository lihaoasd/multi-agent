/**
 * 任务状态机（纯函数，domain 层；P2 归位，2026-09-14）。
 *
 * 状态与合法流转取自 `TaskService.assertTransition` 的既有实现（迁移前内联在 service 里，
 * 属"领域规则混在 application 层"）。这里只做**判定**，不涉及 IO、不产生 id/时间：
 *   · service 负责读盘/加锁/写盘/通知
 *   · 状态合法性、单工槽位、去重键归一化等规则集中在本文件
 */

/** 任务状态：已发布·待领取 / 已领取·进行中 / 完成 / 受阻 / 终止。 */
export const TASK_STATES = ['todo', 'in_progress', 'done', 'blocked', 'terminated'] as const
export type TaskState = (typeof TASK_STATES)[number]

/** 活跃态（用于去重判定：终态不拦重复发布）。 */
export const ACTIVE_TASK_STATES: TaskState[] = ['todo', 'in_progress']

/** 合法流转表（原样取自既有实现，含"终态无出边"）。 */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ['in_progress', 'blocked'],
  blocked: ['todo', 'in_progress'],
  in_progress: ['done', 'terminated', 'blocked'],
  done: [],
  terminated: [],
}

/**
 * 合法流转的判定文本：允许则返回 null，否则返回**与既有实现逐字一致**的拒绝原因
 * （由 service 包成 AppError，保持 REST 文案不变）。
 */
export function taskTransitionError(from: string, to: string): string | null {
  const allow = TASK_TRANSITIONS[from as TaskState] ?? []
  if (allow.includes(to as TaskState)) return null
  return `非法状态流转 ${from} → ${to}（允许: ${allow.join(', ') || '无（终态）'}）`
}

/** 标题归一化（去空白/标点/符号 + 小写）：用于跨管理者同题去重。 */
export function normalizeTaskTitle(title: string): string {
  return title.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/** 协调者角色前缀（pm/product 可代他人置任务状态）。 */
export const COORDINATOR_PREFIXES = ['pm', 'product'] as const

/** 实例 id 是否为协调者角色（pm_1 / product_1）。 */
export function isCoordinator(actor: string): boolean {
  return COORDINATOR_PREFIXES.some((p) => actor === p || actor.startsWith(`${p}_`))
}

/** 任务记录的最小投影（判定只关心这些字段）。 */
export interface TaskLike {
  id: string
  title: string
  state: TaskState
  assignee: string
  creator: string
  ts: string
}

/**
 * 单工槽位：该受派人是否已有**另一个**进行中任务（每 Agent 至多 1 个）。
 * 返回占用者（没有则 null）。
 */
export function findBusySlot<T extends TaskLike>(
  tasks: T[],
  assignee: string,
  excludeTaskId?: string,
): T | null {
  return (
    tasks.find(
      (t) => t.id !== excludeTaskId && t.assignee === assignee && t.state === 'in_progress',
    ) ?? null
  )
}

/** 默认领取目标：该受派人**最旧**的一条待领取任务（按 ts 升序）。 */
export function pickDefaultClaim<T extends TaskLike>(tasks: T[], actor: string): T | undefined {
  return tasks
    .filter((t) => t.assignee === actor && t.state === 'todo')
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))[0]
}

/** 去重命中：同受派人 + 同归一化标题 + 活跃态。 */
export function findDuplicateTask<T extends TaskLike>(
  tasks: T[],
  assignee: string,
  title: string,
): T | undefined {
  const key = normalizeTaskTitle(title)
  return tasks.find(
    (t) =>
      t.assignee === assignee &&
      ACTIVE_TASK_STATES.includes(t.state) &&
      normalizeTaskTitle(t.title) === key,
  )
}
