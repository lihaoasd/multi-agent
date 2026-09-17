import type { QuestionItemView, QuestionRecord } from '../api/work'

/**
 * 询问向导（S33，纯函数，可被 node 侧单测）：**一次一个问题、逐题作答、攒齐后一次提交**。
 *
 * 为什么不能逐题提交：`QuestionService.answer()` 一旦被调用就会**立即唤醒提问的 Agent**
 * （解析 waiter + 通知 asker）。所以 UI 必须在本地收集全部答复，最后一次 POST 提交，
 * 否则第一个问题答完 Agent 就带着半份答复继续跑了。
 */

export interface AnswerDraft {
  readonly choice?: string
  readonly text?: string
}

export type AnswerMap = Readonly<Record<string, AnswerDraft>>

/** 记下某一题的答复（choice 与 text 互斥：有选项用 choice，无选项用 text） */
export function withAnswer(answers: AnswerMap, itemId: string, draft: AnswerDraft): AnswerMap {
  return { ...answers, [itemId]: draft }
}

/** 已答题目数 */
export function answeredCount(question: QuestionRecord, answers: AnswerMap): number {
  return question.items.filter((item) => answers[item.id] !== undefined).length
}

/** 必答项是否都已作答（`required` 为 false 的题可跳过） */
export function canSubmit(question: QuestionRecord, answers: AnswerMap): boolean {
  return question.items.every((item) => item.required !== true || answers[item.id] !== undefined)
}

/** 缺哪些必答项（用于提示与调试） */
export function missingRequired(question: QuestionRecord, answers: AnswerMap): readonly string[] {
  return question.items.filter((item) => item.required === true && answers[item.id] === undefined).map((item) => item.id)
}

/** 下标推进/回退（在两端夹住，不循环——避免用户"转到头又回到第一题"的困惑） */
export function stepCursor(cursor: number, delta: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(cursor + delta, 0), total - 1)
}

/** 滑动位移 → 是否切题（阈值 60px；返回 -1/0/1） */
export function swipeDirection(deltaX: number, threshold = 60): -1 | 0 | 1 {
  if (deltaX <= -threshold) return 1
  if (deltaX >= threshold) return -1
  return 0
}

/** 提交负载：只带已作答的题（未作答的选答题不出现） */
export function toAnswerPayload(
  question: QuestionRecord,
  answers: AnswerMap,
): readonly { readonly itemId: string; readonly choice?: string | null; readonly text?: string | null }[] {
  return question.items
    .filter((item: QuestionItemView) => answers[item.id] !== undefined)
    .map((item) => {
      const draft = answers[item.id] ?? {}
      return {
        itemId: item.id,
        ...(draft.choice === undefined ? {} : { choice: draft.choice }),
        ...(draft.text === undefined ? {} : { text: draft.text }),
      }
    })
}
