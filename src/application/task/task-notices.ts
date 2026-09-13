/**
 * 任务栏的「通知文案」（**纯函数**，P3 从 `composition.ts` 抽出，2026-09-14）。
 *
 * 任务栏流程（2026-09-12）里有两处平台系统消息，文案原先内联在组合根的任务钩子里：
 *  1. `notifyClaim`     —— 发布/槽位释放 → 通知受派人**来领取**；
 *  2. `notifyDelegator` —— 完成/受阻/终止 → 通知**委派人**安排后续（带受派人总结）。
 *
 * 抽成纯函数后，组合根只负责"发给谁、何时发"，文案可单独断言。
 * **文案内容与原实现逐字一致**——改字即行为变更，不属于纯重构。
 */

/** 任务的最小投影（文案只需要 id/标题/描述/委派人）。 */
export interface TaskBrief {
  id: string
  title: string
  desc?: string | null
  creator: string
  /** 最近一次状态变更时受派人给的说明（完成总结/受阻原因） */
  resultNote?: string | null
}

/** 通知受派人"任务栏有任务待你领取"。 */
export function taskClaimNotice(task: TaskBrief): string {
  return (
    `【系统】任务栏有任务待你领取 ${task.id}「${task.title}」` +
    (task.desc ? `：${task.desc.slice(0, 300)}` : '') +
    `（委派人：${task.creator}）。请调用 task_claim 领取并开工；` +
    '完成后必须调用 task_update(state=done, note=一句话完成总结)，并在回复里给用户一段完成总结' +
    '（做了什么/产出文件/验证结果/遗留）。若暂时不能接，请用 task_update 置 blocked 并说明原因。'
  )
}

/** 通知委派人"你委派的任务已完成/受阻/终止"，带受派人总结。 */
export function taskDelegatorNotice(input: {
  task: TaskBrief
  event: 'done' | 'blocked' | 'terminated'
  by: string
}): string {
  const { task, event, by } = input
  const zh = event === 'done' ? '已完成' : event === 'blocked' ? '受阻' : '已终止'
  const note = task.resultNote?.trim()
  return (
    `【系统】你委派的任务 ${task.id}「${task.title}」${zh}（受派人 ${by}）。` +
    (note ? `\n受派人总结：${note.slice(0, 500)}` : '') +
    '\n请据此安排后续：验收产出、派发下一步任务，或发起会议对齐。'
  )
}
