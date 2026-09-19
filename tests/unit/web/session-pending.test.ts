import { describe, expect, it } from 'vitest'
import { pendingForSession } from '../../../web/src/lib/session-pending'

/**
 * S45/D48：用户口径"谁的发出的审批，应该显示在谁的窗口下面"。
 * 审批/询问卡必须按当前会话过滤（原先审批卡渲染的是项目全量）。
 */
describe('session-pending · 待处理项按会话过滤', () => {
  const items = [
    { id: 'a1', sessionId: 'u_dev_1' },
    { id: 'a2', sessionId: 'u_qa_1' },
    { id: 'a3', sessionId: 'u_dev_1' },
  ]

  it('只保留当前会话的项，并保持原顺序', () => {
    expect(pendingForSession(items, 'u_dev_1').map((item) => item.id)).toEqual(['a1', 'a3'])
    expect(pendingForSession(items, 'u_qa_1').map((item) => item.id)).toEqual(['a2'])
  })

  it('别人的会话不显示（这正是"审批跑到别人窗口"的修复点）', () => {
    expect(pendingForSession(items, 'u_architect_1')).toEqual([])
  })

  it('未选中会话（null/空串）时一律不显示', () => {
    expect(pendingForSession(items, null)).toEqual([])
    expect(pendingForSession(items, '')).toEqual([])
  })

  it('空列表不报错', () => {
    expect(pendingForSession([], 'u_dev_1')).toEqual([])
  })
})
