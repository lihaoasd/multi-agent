import { describe, expect, it } from 'vitest'
import {
  answeredCount,
  canSubmit,
  missingRequired,
  stepCursor,
  swipeDirection,
  toAnswerPayload,
  withAnswer,
} from '../../../web/src/lib/question-wizard'
import type { QuestionRecord } from '../../../web/src/api/work'

/**
 * 询问向导（S33）：**一次一题、攒齐后一次提交**。
 * 关键约束来自后端语义：`QuestionService.answer()` 一被调用就**立刻唤醒 Agent**，
 * 所以逐题 POST 会让 Agent 带着半份答复继续跑——答复必须在本地攒齐。
 */
const question: QuestionRecord = {
  id: 'q_1',
  sessionId: 'u_pm_1',
  asker: 'pm_1',
  title: '贪吃蛇做成哪种形态？',
  items: [
    { id: 'i_1', text: '运行形态？', options: ['网页版', '终端版'], required: true },
    { id: 'i_2', text: '操作方式？', options: [], required: true },
    { id: 'i_3', text: '补充说明（选答）', options: [], required: false },
  ],
  status: 'pending',
  answer: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  answeredAt: null,
}

describe('web/lib/question-wizard · 逐题作答 + 攒齐提交', () => {
  it('记答复：choice 与 text 两种形态都保留，且不覆盖其它题', () => {
    const first = withAnswer({}, 'i_1', { choice: '网页版' })
    const both = withAnswer(first, 'i_2', { text: '方向键' })
    expect(both).toEqual({ i_1: { choice: '网页版' }, i_2: { text: '方向键' } })
    // 重答同一题时覆盖旧值
    expect(withAnswer(both, 'i_1', { choice: '终端版' }).i_1).toEqual({ choice: '终端版' })
  })

  it('已答计数与必答校验：选答题未答也能提交', () => {
    const answers = { i_1: { choice: '网页版' }, i_2: { text: '方向键' } }
    expect(answeredCount(question, answers)).toBe(2)
    expect(canSubmit(question, answers)).toBe(true)
    expect(missingRequired(question, answers)).toEqual([])
  })

  it('必答题缺答时不可提交，并点名缺哪题', () => {
    const answers = { i_1: { choice: '网页版' } }
    expect(canSubmit(question, answers)).toBe(false)
    expect(missingRequired(question, answers)).toEqual(['i_2'])
  })

  it('切题在两端夹住（不循环）', () => {
    expect(stepCursor(0, -1, 3)).toBe(0)
    expect(stepCursor(2, 1, 3)).toBe(2)
    expect(stepCursor(1, 1, 3)).toBe(2)
    expect(stepCursor(1, -1, 3)).toBe(0)
    expect(stepCursor(0, 1, 0)).toBe(0)
  })

  it('滑动位移 → 切题方向（阈值 60px）', () => {
    expect(swipeDirection(0)).toBe(0)
    expect(swipeDirection(59)).toBe(0)
    expect(swipeDirection(60)).toBe(-1) // 右滑 = 上一题
    expect(swipeDirection(-60)).toBe(1) // 左滑 = 下一题
    expect(swipeDirection(120, 100)).toBe(-1)
  })

  it('提交负载只带已作答的题（选答题留空时不出现）', () => {
    expect(toAnswerPayload(question, { i_1: { choice: '网页版' }, i_2: { text: '方向键' } })).toEqual([
      { itemId: 'i_1', choice: '网页版' },
      { itemId: 'i_2', text: '方向键' },
    ])
  })
})
