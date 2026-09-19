import { describe, expect, it } from 'vitest'
import { isSending, withSending, withoutSending } from '../../../web/src/lib/sending'

/**
 * S46/D49：用户报告"角色发送消息后，其他角色发不了"。
 * 根因是"发送中"用了全局标记——而 `POST /messages` 要等整个回合跑完才响应，
 * 于是给 A 发消息期间（按钮一直转圈），切到 B 也发不出。标记必须按会话记。
 */
describe('sending · 按会话的"发送中"标记', () => {
  it('只影响被标记的那个会话（其它会话不受影响）', () => {
    const state = withSending([], 'u_dev_1')
    expect(isSending(state, 'u_dev_1')).toBe(true)
    expect(isSending(state, 'u_qa_1')).toBe(false)
  })

  it('两个会话可同时处于发送中（各自独立）', () => {
    const state = withSending(withSending([], 'u_dev_1'), 'u_qa_1')
    expect(state).toEqual(['u_dev_1', 'u_qa_1'])
    expect(isSending(state, 'u_dev_1')).toBe(true)
    expect(isSending(state, 'u_qa_1')).toBe(true)
  })

  it('标记/清除都是幂等的，且不改原数组', () => {
    const first = withSending([], 'u_dev_1')
    expect(withSending(first, 'u_dev_1')).toBe(first)
    expect(first).toEqual(['u_dev_1'])
    const cleared = withoutSending(first, 'u_dev_1')
    expect(cleared).toEqual([])
    expect(first).toEqual(['u_dev_1'])
    expect(withoutSending(cleared, 'u_dev_1')).toBe(cleared)
  })

  it('清除一个会话不影响另一个', () => {
    const state = ['u_dev_1', 'u_qa_1']
    expect(withoutSending(state, 'u_dev_1')).toEqual(['u_qa_1'])
  })

  it('未选中会话（null/空串）一律视为"没有在发送"', () => {
    expect(isSending(['u_dev_1'], null)).toBe(false)
    expect(isSending(['u_dev_1'], '')).toBe(false)
  })
})
