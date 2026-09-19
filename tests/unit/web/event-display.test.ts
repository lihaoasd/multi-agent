import { describe, expect, it } from 'vitest'
import {
  eventBody,
  eventLabel,
  eventRow,
  isToolFailed,
  messageTextOf,
  toolInputOf,
  toolNameOf,
  traceLine,
} from '../../../web/src/lib/event-display'

/**
 * 会话事件 → 展示文本（S24）。
 *
 * fixtures **照抄生产者**（`src/application/agent-loop/strategies.ts`）真实写出的 payload：
 * - `tool_call`：`{ tool, callId, input }`（`input` = `summarizeArgs()` 的 JSON 文本，≤400 字符）
 * - `tool_result`：`{ tool, callId, ok, summary }`（`summary` = 结果文本，≤2000 字符）
 *
 * 这组用例的存在原因：S22 曾按 `name`/`args`/`text` 读取，界面于是把工具名显示成「工具」、
 * 参数与结果全空——**fixture 与生产者不一致**就是这个缺陷能溜过测试的原因（见 S24 修改记录）。
 */
describe('web/lib/event-display · 会话事件展示映射', () => {
  const toolCall = (input: unknown) => ({
    kind: 'tool_call',
    seq: 12,
    turn: 3,
    payload: { tool: 'fs_read_file', callId: 'call_1', input },
  })
  const toolResult = (ok: boolean, summary: string) => ({
    kind: 'tool_result',
    seq: 13,
    turn: 3,
    payload: { tool: 'fs_read_file', callId: 'call_1', ok, summary },
  })

  it('工具名取生产者字段 `tool`（兼容 `name`），缺失时退化为「工具」', () => {
    expect(toolNameOf(toolCall('{}'))).toBe('fs_read_file')
    expect(toolNameOf({ kind: 'tool_call', seq: 1, turn: 1, payload: { name: 'cmd_run' } })).toBe('cmd_run')
    expect(toolNameOf({ kind: 'tool_result', seq: 1, turn: 1, payload: {} })).toBe('工具')
  })

  it('工具调用：标题带工具名，正文给出参数结构（JSON 被格式化）', () => {
    const event = toolCall('{"path":"src/a.ts","limit":20}')
    expect(eventLabel(event)).toBe('工具调用 fs_read_file')
    expect(eventBody(event)).toBe('{\n  "path": "src/a.ts",\n  "limit": 20\n}')
  })

  it('工具调用：参数被截断或非 JSON 时原样显示（不丢字符、不抛异常）', () => {
    expect(eventBody(toolCall('{"path":"src/a.ts","content":"很长…'))).toBe('{"path":"src/a.ts","content":"很长…')
  })

  it('工具结果：成功时**只显示工具名**（S26）；失败时**显示报错内容**（S34）', () => {
    const ok = toolResult(true, '读到了文件（1 行）')
    expect(eventRow(ok)).toEqual({ label: 'fs_read_file', body: null, showMeta: false, bodyMode: 'none' })
    expect(isToolFailed(ok)).toBe(false)

    const failed = toolResult(false, '[ERR_FORBIDDEN] 归属校验失败：该文件属于 dev_1')
    expect(eventRow(failed)).toEqual({
      label: 'fs_read_file',
      body: '[ERR_FORBIDDEN] 归属校验失败：该文件属于 dev_1',
      showMeta: false,
      bodyMode: 'inline',
    })
    expect(isToolFailed(failed)).toBe(true)
  })

  it('工具调用：参数默认折叠（S28）；无参数时退化为纯标题行', () => {
    expect(eventRow(toolCall('{"path":"a.ts"}'))).toEqual({
      label: '工具调用 fs_read_file',
      body: '{\n  "path": "a.ts"\n}',
      showMeta: true,
      bodyMode: 'collapsed',
    })
    expect(eventRow(toolCall(undefined))).toEqual({
      label: '工具调用 fs_read_file',
      body: null,
      showMeta: true,
      bodyMode: 'none',
    })
  })

  it('思考：标题 + 正文**默认折叠**（S41/D44）；错误仍 inline', () => {
    expect(eventRow({ kind: 'thought', seq: 2, turn: 1, payload: { text: '先看目录' } })).toEqual({
      label: '思考',
      body: '先看目录',
      showMeta: true,
      bodyMode: 'collapsed',
    })
    // 没有正文时退化为纯标题行（不出现空折叠面板）
    expect(eventRow({ kind: 'thought', seq: 3, turn: 1, payload: { text: '   ' } })).toEqual({
      label: '思考',
      body: null,
      showMeta: true,
      bodyMode: 'none',
    })
    expect(eventRow({ kind: 'error', seq: 9, turn: 1, payload: { text: 'ERR_MODEL' } })).toEqual({
      label: '错误',
      body: 'ERR_MODEL',
      showMeta: true,
      bodyMode: 'inline',
    })
  })

  it('思考与错误：正文取 `text`', () => {
    expect(eventLabel({ kind: 'thought', seq: 2, turn: 1, payload: { text: '先看目录' } })).toBe('思考')
    expect(eventBody({ kind: 'thought', seq: 2, turn: 1, payload: { text: '先看目录' } })).toBe('先看目录')
    expect(eventBody({ kind: 'error', seq: 9, turn: 1, payload: { text: 'ERR_MODEL' } })).toBe('ERR_MODEL')
  })

  it('S43/D46：思考行标出"这一步是干什么的"（制定计划 / 执行第 N 步 / 汇总工具结果…）', () => {
    // 有来源：标题 = `思考 · <来源>`，说明为什么会有两条连着（中间只隔一个不显示的 plan 事件）
    expect(eventLabel({ kind: 'thought', seq: 2, turn: 1, payload: { text: '先拆两步', purpose: '制定计划' } })).toBe(
      '思考 · 制定计划',
    )
    expect(eventLabel({ kind: 'thought', seq: 3, turn: 1, payload: { text: '开始第一步', purpose: '执行第 1 步' } })).toBe(
      '思考 · 执行第 1 步',
    )
    // 旧事件/空来源：退回纯「思考」，不影响历史日志
    expect(eventLabel({ kind: 'thought', seq: 4, turn: 1, payload: { text: '老日志' } })).toBe('思考')
    expect(eventLabel({ kind: 'thought', seq: 5, turn: 1, payload: { text: '老日志', purpose: '   ' } })).toBe('思考')
    // 详细日志里同样带来源
    expect(
      traceLine({ kind: 'thought', seq: 6, turn: 1, ts: '2026-09-17T11:52:29.007Z', payload: { text: '想一下', purpose: '制定计划' } }).text,
    ).toBe('制定计划：想一下')
  })

  it('S44/D47：计划行可见——产出时给步骤清单，之后给进度/结果', () => {
    const steps = [
      { step: 1, title: '读代码' },
      { step: 2, title: '写方案' },
    ]
    // 产出：标题给步数，正文是编号步骤（会话流里这就是两次思考之间的分界）
    expect(eventRow({ kind: 'plan', seq: 10, turn: 1, payload: { planId: 'p1', steps, stepIndex: 0, status: 'running' } })).toEqual({
      label: '计划（2 步）',
      body: '1. 读代码\n2. 写方案',
      showMeta: true,
      bodyMode: 'inline',
    })
    // 进度：只留一行标题（不重复步骤清单）
    expect(eventRow({ kind: 'plan', seq: 11, turn: 1, payload: { planId: 'p1', steps, stepIndex: 1, status: 'running' } })).toEqual({
      label: '计划进度 · 第 1/2 步',
      body: null,
      showMeta: true,
      bodyMode: 'none',
    })
    expect(eventLabel({ kind: 'plan', seq: 12, turn: 1, payload: { planId: 'p1', steps, stepIndex: 2, status: 'done' } })).toBe(
      '计划完成 · 2 步',
    )
    expect(
      eventLabel({ kind: 'plan', seq: 13, turn: 1, payload: { planId: 'p1', steps, stepIndex: 2, status: 'interrupted' } }),
    ).toBe('计划已中断 · 第 2/2 步')
    // 字符串步骤 / 缺 steps（旧数据）也不崩
    expect(eventRow({ kind: 'plan', seq: 14, turn: 1, payload: { steps: ['A', 'B'], stepIndex: 0, status: 'running' } }).body).toBe(
      '1. A\n2. B',
    )
    expect(eventLabel({ kind: 'plan', seq: 15, turn: 1, payload: { stepIndex: 0, status: 'running' } })).toBe('计划（1 步）')
  })

  it('消息正文：`payload.text` 与 `payload.content.text` 两种形态都支持', () => {
    expect(messageTextOf({ kind: 'message', seq: 1, turn: 1, payload: { role: 'user', text: '你好' } })).toBe('你好')
    expect(
      messageTextOf({ kind: 'message', seq: 2, turn: 1, payload: { role: 'agent', content: { text: '收到' } } }),
    ).toBe('收到')
    expect(messageTextOf({ kind: 'message', seq: 3, turn: 1, payload: { role: 'agent' } })).toBe('（空消息）')
  })

  it('详细日志（trace）行：头部含序号/时间/turn/kind，摘要覆盖全部 kind（S35）', () => {
    const at = '2026-09-17T11:52:29.007Z'
    // S39/D42：时间按**本地**钟点显示（原先是 ISO 串切片 → UTC，UTC+8 差 8 小时）
    const local = new Date(at)
    const pad = (value: number, width: number): string => String(value).padStart(width, '0')
    const clock = `${pad(local.getHours(), 2)}:${pad(local.getMinutes(), 2)}:${pad(local.getSeconds(), 2)}.${pad(local.getMilliseconds(), 3)}`
    expect(traceLine({ kind: 'message', seq: 42, turn: 1, ts: at, payload: { role: 'agent', text: '开工' } })).toEqual({
      head: `#42 · ${clock} · turn 1 · message`,
      text: 'Agent：开工',
    })
    // 对话视图里被隐藏的 plan / turn 边界 / state 在详细日志里都要有可读摘要
    expect(
      traceLine({ kind: 'plan', seq: 3, turn: 1, ts: at, payload: { status: 'running', steps: [{}, {}], stepIndex: 0 } }).text,
    ).toBe('计划 running（2 步） · 当前第 0 步')
    expect(traceLine({ kind: 'turn_start', seq: 2, turn: 1, ts: at, payload: { loopStep: 'plan-execute', steps: [{}] } }).text).toBe(
      'loop=plan-execute · plan 1 步',
    )
    expect(traceLine({ kind: 'turn_end', seq: 43, turn: 1, ts: at, payload: { status: 'done' } }).text).toBe('done')
    expect(traceLine({ kind: 'state', seq: 9, turn: 1, ts: at, payload: { dsmlUnparsed: 1 } }).text).toBe('{"dsmlUnparsed":1}')
    // 工具结果：成功/失败都在摘要里说清
    expect(traceLine({ kind: 'tool_result', seq: 5, turn: 1, ts: at, payload: { tool: 'fs_list_dir', ok: true, summary: '/' } }).text).toBe(
      '成功 · fs_list_dir：/',
    )
    expect(traceLine({ kind: 'tool_result', seq: 6, turn: 1, ts: at, payload: { tool: 'fs_read_file', ok: false, summary: '[ERR_FORBIDDEN] 拒改' } }).text).toBe(
      '失败 · fs_read_file：[ERR_FORBIDDEN] 拒改',
    )
    // 时间戳缺失时不崩（历史事件可能没有）
    expect(traceLine({ kind: 'error', seq: 7, turn: 1, payload: { text: 'ERR_MODEL' } })).toEqual({
      head: '#7 ·  · turn 1 · error',
      text: 'ERR_MODEL',
    })
  })

  it('工具调用无参数：正文为空字符串（标题已带工具名，不会显示 `undefined`）', () => {
    expect(toolInputOf(toolCall(undefined))).toBe('')
    expect(eventBody(toolCall(undefined))).toBe('')
  })
})
