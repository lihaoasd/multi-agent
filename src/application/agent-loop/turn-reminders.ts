/**
 * 回合末兜底提醒的**文案构建**（纯函数；P3g 从 `loop-runner.ts` 抽出，2026-09-14）。
 *
 * 抽出的理由：这段是约 30 行的提示文案拼接，与 runner 的存储/广播职责混在一起。
 * 变成纯函数后：不依赖 store/bus，可单独断言；runner 只负责"取数 → 判断 → 落盘"。
 *
 * 三种提醒（各自独立，可同时出现）：
 *  1. 有进行中任务但本回合没调用 `task_update` → 提醒上报完成（平台据此通知委派人）；
 *  2. 任务栏还有派给我但未领取的任务，且本回合没 `task_claim` → 提醒先领取再上报；
 *  3. 本回合只调工具、没有任何正文 → 提醒补一条面向用户的完成总结。
 */
export interface ReminderActiveTask {
  id: string
  title: string
}

export interface ReminderPendingTask {
  id: string
  title: string
}

export interface TurnEndReminderInput {
  /** 本回合调用过工具的次数（0 = 没干活，不提醒） */
  toolCallCount: number
  /** 因提问挂起（等待用户决策）→ 不催任务状态 */
  suspendedForUser: boolean
  /** 本回合结束时的进行中任务（必须是**回合结束时新读取**的结果，不是回合开始快照） */
  freshActive: ReminderActiveTask | null
  /** 本回合结束时的待领取任务 */
  freshPending: ReminderPendingTask[]
  /** 本回合调用过的工具名 */
  calledTools: ReadonlySet<string>
  /** 本回合是否输出过正文（否则补提醒） */
  replied: boolean
}

/** 构建提醒文案；无话可说时返回空数组（调用方据此决定是否落盘）。 */
export function buildTurnEndReminders(input: TurnEndReminderInput): string[] {
  if (input.toolCallCount === 0) return []
  if (input.suspendedForUser) return []
  const reported = input.calledTools.has('task_update')
  const notes: string[] = []
  if (!reported && input.freshActive) {
    notes.push(
      `【系统】任务 ${input.freshActive.id}「${input.freshActive.title}」仍为进行中。若本轮已完成，` +
        '请调用 task_update(state=done, note=一句话完成总结) 上报——平台会更新任务栏并通知委派人；' +
        '若仍在进行，可忽略本提示。',
    )
  }
  if (!reported && !input.calledTools.has('task_claim') && input.freshPending.length) {
    const first = input.freshPending[0]!
    notes.push(
      `【系统】任务栏上还有待你领取的任务 ${first.id}「${first.title}」。` +
        '如果你已经做完了这件事，请先 task_claim 领取，再 task_update(state=done, note=完成总结)。',
    )
  }
  if (!input.replied) {
    notes.push(
      '【系统】本轮只执行了工具、没有输出任何正文与总结。请补一条面向用户的完成总结' +
        '（做了什么、产出文件、验证结果、遗留），并在任务完成时用 task_update(state=done, note=总结) 上报。',
    )
  }
  return notes
}
