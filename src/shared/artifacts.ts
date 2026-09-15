/**
 * 产出物与任务的共享常量（真源：docs/design/workspaces-artifacts.md §1、data-storage.md §6/§7）。
 * 纯常量，无依赖：校验、UI 与适配器共用同一份词汇。
 */

/** 产出物类型注册表（MVP）：doc/config/deploy 为"快照类"，code 为"补丁类"，test 属快照类 */
export const ARTIFACT_TYPES = ['doc', 'code', 'config', 'test', 'deploy'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

/** 快照类产出（回退内容依据=各文件完整快照）；code 为补丁类 */
export const SNAPSHOT_ARTIFACT_TYPES: readonly ArtifactType[] = ['doc', 'config', 'test', 'deploy']

export const ARTIFACT_STATES = ['submitted', 'approved', 'rejected', 'reverted'] as const
export type ArtifactState = (typeof ARTIFACT_STATES)[number]

export const TASK_STATES = ['todo', 'in_progress', 'done', 'blocked', 'terminated'] as const
export type TaskState = (typeof TASK_STATES)[number]

/** 活跃（未终结）任务状态：去重与"单 in_progress"判定只看这两个 */
export const TASK_ACTIVE_STATES: readonly TaskState[] = ['todo', 'in_progress']
/** 终结状态：释放 in_progress 槽位 */
export const TASK_TERMINAL_STATES: readonly TaskState[] = ['done', 'blocked', 'terminated']

export const QUESTION_STATUSES = ['pending', 'answered'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

export const FILE_OWNER_VIA = ['workdir_edit', 'artifact_submit'] as const
export type FileOwnerVia = (typeof FILE_OWNER_VIA)[number]

/**
 * 未结算改动的聚合键（workspaces-artifacts §2.2 / D14-⑧）：
 * 有激活任务 → 按任务聚合；无任务 → 按回合兜底。
 */
export function pendingKeyFor(input: {
  readonly taskId: string | null
  readonly sessionId: string
  readonly turn: number
}): string {
  return input.taskId !== null ? `task-${input.taskId}` : `turn-${input.sessionId}-${input.turn}`
}
