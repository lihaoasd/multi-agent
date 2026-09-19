import { describe, expect, it } from 'vitest'
import { composerStatus, openToolCall } from '../../../web/src/lib/composer-status'
import type { EventLike } from '../../../web/src/lib/event-display'

/**
 * S42/D45：用户口径"对话框里需要有个等待交互，让用户知道现在正在调用工具，还是模型"。
 * 这里把"在调工具 / 在生成 / 在思考 / 等你答复 / 排队"分清楚。
 */
const event = (kind: string, seq: number, payload: Record<string, unknown> = {}): EventLike => ({
  kind,
  seq,
  turn: 1,
  payload,
})

const idle = { state: 'idle', paused: false, queued: 0 }
const base = { status: idle, events: [] as EventLike[], streaming: false, hasPendingQuestion: false }

describe('composer-status · 输入框上方的"现在在干什么"', () => {
  it('空闲且无排队：不显示（不占版面）', () => {
    expect(composerStatus(base)).toBeNull()
  })

  it('正在调用工具：说出工具名 + 转圈', () => {
    const events = [event('turn_start', 1), event('tool_call', 2, { tool: 'fs_read_file', callId: 'c1' })]
    expect(composerStatus({ ...base, status: { ...idle, state: 'working' }, events })).toEqual({
      text: '正在调用工具 fs_read_file…',
      tone: 'working',
      spinner: true,
    })
  })

  it('工具已有结果：回到"模型正在思考/输出"', () => {
    const events = [
      event('tool_call', 2, { tool: 'fs_read_file', callId: 'c1' }),
      event('tool_result', 3, { tool: 'fs_read_file', callId: 'c1', ok: true }),
    ]
    const working = { ...idle, state: 'working' }
    expect(composerStatus({ ...base, status: working, events })?.text).toBe('模型正在思考…')
    expect(composerStatus({ ...base, status: working, events, streaming: true })?.text).toBe('模型正在输出…')
  })

  it('等待答复 / 等待审批：不转圈，语气为 waiting', () => {
    expect(composerStatus({ ...base, status: { ...idle, state: 'waiting', waitingFor: 'question' } })).toEqual({
      text: '等待你的答复（在下方答复卡里作答）',
      tone: 'waiting',
      spinner: false,
    })
    expect(composerStatus({ ...base, status: { ...idle, state: 'waiting', waitingFor: 'approval' } })).toEqual({
      text: '等待你的审批',
      tone: 'waiting',
      spinner: false,
    })
    // 状态投影缺 waitingFor 但本会话有待答询问时，也按"等答复"说
    expect(composerStatus({ ...base, status: { ...idle, state: 'waiting' }, hasPendingQuestion: true })?.tone).toBe(
      'waiting',
    )
  })

  it('暂停 / 排队', () => {
    expect(composerStatus({ ...base, status: { ...idle, paused: true } })).toEqual({
      text: '已暂停：不再领新活（恢复后继续处理队列）',
      tone: 'paused',
      spinner: false,
    })
    expect(composerStatus({ ...base, status: { ...idle, queued: 2 } })).toEqual({
      text: '排队 2 条，稍后处理',
      tone: 'idle',
      spinner: false,
    })
  })
})

describe('composer-status · openToolCall', () => {
  it('未闭合的 tool_call 才是"正在调用"', () => {
    expect(openToolCall([event('tool_call', 1, { tool: 'cmd_run', callId: 'c1' })])).toBe('cmd_run')
    expect(
      openToolCall([
        event('tool_call', 1, { tool: 'cmd_run', callId: 'c1' }),
        event('tool_result', 2, { callId: 'c1', ok: true }),
      ]),
    ).toBeNull()
  })

  it('只认最近的回合：message / turn_end 之后的旧调用不算', () => {
    const events = [
      event('tool_call', 1, { tool: 'cmd_run', callId: 'c1' }),
      event('tool_result', 2, { callId: 'c1', ok: true }),
      event('message', 3, { role: 'agent', text: '做完了' }),
    ]
    expect(openToolCall(events)).toBeNull()
  })

  it('多工具并行：只看最后一次未闭合的调用', () => {
    const events = [
      event('tool_call', 1, { tool: 'a', callId: 'c1' }),
      event('tool_call', 2, { tool: 'b', callId: 'c2' }),
      event('tool_result', 3, { callId: 'c1', ok: true }),
    ]
    expect(openToolCall(events)).toBe('b')
  })
})
