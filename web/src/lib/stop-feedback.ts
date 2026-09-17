/**
 * 「停止生成 / 停止任务」的结果文案（S37）。
 *
 * 起因：用户点「停止生成」时，Agent 空闲也照样弹「已请求停止当前回合」——看着像成功、其实什么也没停，
 * 于是"停止生成到底是什么功能"就成了疑问。文案必须**如实反映 `aborted`**。
 * 纯函数：node 侧可单测（沿用 S23/S26/S28/S33/S35 的做法），组件只做映射。
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

/** 停止生成（`scope='turn'`）：停当前回合输出；没有在途回合时如实说"没停到东西" */
export function stopTurnFeedback(result: StopOutcome): StopFeedback {
  if (!result.aborted) {
    return { kind: 'info', text: '当前没有正在生成的回合（该 Agent 空闲或已暂停）' }
  }
  return {
    kind: 'success',
    text: result.queued > 0 ? `已停止生成（队列保留 ${result.queued} 条，下次触发时处理）` : '已停止生成',
  }
}

/** 停止任务（`scope='task'`）：终止当前任务，未结算改动先结算为快照 */
export function stopTaskFeedback(result: StopOutcome): StopFeedback {
  if (result.taskId === null) return { kind: 'info', text: '没有进行中的任务' }
  return {
    kind: 'success',
    text: `已终止任务 ${result.taskId}${result.settledArtifactId === null ? '' : `，已结算快照 ${result.settledArtifactId}`}`,
  }
}
