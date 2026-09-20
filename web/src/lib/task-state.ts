import type { TaskState } from '../api/work'

/**
 * 「任务与产出物」里任务状态下拉的逻辑（S55/D59，纯函数便于 node 侧单测）。
 *
 * 两条口径：
 * - **不再提供「受阻」**（S53/D57）：任务没有这个状态，服务端也会拒绝；
 * - **不再提供"当前状态"**：选它只会得到一句「任务已是 X 状态」的报错（用户报"任务状态不能修改"的
 *   一类观感来源），干脆从选项里去掉；当前状态是历史值（`blocked`）时补一条**禁用**项，
 *   让下拉显示中文名而不是原始英文值。
 */

/** 用户能主动设置的状态（不含 blocked） */
export const SELECTABLE_TASK_STATES: readonly TaskState[] = ['todo', 'in_progress', 'done', 'terminated']

export interface TaskStateOption {
  readonly value: TaskState
  readonly label: string
  /** 历史状态的占位项（只用来显示，不能选） */
  readonly disabled: boolean
}

export function taskStateOptions(
  current: TaskState,
  labels: Readonly<Record<TaskState, string>>,
): readonly TaskStateOption[] {
  const options: TaskStateOption[] = []
  if (!SELECTABLE_TASK_STATES.includes(current)) {
    options.push({ value: current, label: labels[current], disabled: true })
  }
  for (const state of SELECTABLE_TASK_STATES) {
    if (state === current) continue
    options.push({ value: state, label: labels[state], disabled: false })
  }
  return options
}

/** `ERR_CONFLICT` 且是"该角色已有进行中的任务"时，取出占着槽位的那条任务 */
export function holdingTaskOf(
  detail: Readonly<Record<string, unknown>> | undefined,
): { readonly id: string; readonly title: string } | null {
  const id = detail?.['holding']
  if (typeof id !== 'string' || id.length === 0) return null
  const title = detail?.['holdingTitle']
  return { id, title: typeof title === 'string' && title.length > 0 ? title : id }
}
