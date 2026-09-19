/**
 * 「停止任务」的结果文案（S37）。
 *
 * 说明（S49/D52）：界面上的「停止生成」入口已移除——暂停就是"跑完当前这一轮 loop 后停止生成"，
 * 因此这里只保留停止任务的反馈。
 */

/** 与 `runtimeApi.stop` 的返回同构（避免 lib 依赖 api 层，便于单测） */
export interface StopOutcome {
  readonly aborted: boolean
  readonly taskId: string | null
  readonly settledArtifactId: string | null
  readonly queued: number
}

export interface StopFeedback {
  readonly kind: 'success' | 'info'
  readonly text: string
}

/** 停止任务（`scope='task'`）：终止当前任务，未结算改动先结算为快照 */
export function stopTaskFeedback(result: StopOutcome): StopFeedback {
  if (result.taskId === null) return { kind: 'info', text: '没有进行中的任务' }
  return {
    kind: 'success',
    text: `已终止任务 ${result.taskId}${result.settledArtifactId === null ? '' : `，已结算快照 ${result.settledArtifactId}`}`,
  }
}
