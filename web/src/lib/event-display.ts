/**
 * 会话事件 → 展示文本（S24，纯函数，可被 node 侧单测）。
 *
 * ⚠️ **字段契约（生产者为 `src/application/agent-loop/strategies.ts`）**：
 * - `tool_call`：`{ tool, callId, input }` —— `input` 是参数的 JSON 文本（≤400 字符）
 * - `tool_result`：`{ tool, callId, ok, summary }` —— `summary` 是结果文本（≤2000 字符）
 * - `thought`：`{ text }`；`message`：`{ role, text 或 content.text }`；`error`：`{ text 或 message }`
 *
 * S22 曾按 `name`/`args`/`text` 读取，导致界面上工具名退化成「工具」、参数与结果都不显示（S24 修复）。
 * 这里对 `name`/`args`/`text` 保留兜底，避免旧日志或未来字段调整直接显示空白。
 */

import { localClock } from './time-format'

export interface EventLike {
  readonly kind: string
  readonly seq: number
  readonly turn: number
  /** 事件时间戳（详细日志视图用；历史事件可能没有，故可选） */
  readonly ts?: string
  readonly payload: Record<string, unknown>
}

/** 事件里的工具名（生产者用 `tool`；兼容 `name`） */
export function toolNameOf(event: EventLike): string {
  const name = event.payload['tool'] ?? event.payload['name']
  return typeof name === 'string' && name.length > 0 ? name : '工具'
}

export function isToolFailed(event: EventLike): boolean {
  return event.kind === 'tool_result' && event.payload['ok'] === false
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 消息正文（用户 / Agent），兼容 `payload.text` 与 `payload.content.text` */
export function messageTextOf(event: EventLike): string {
  const direct = asText(event.payload['text'])
  if (direct !== null) return direct
  const content = event.payload['content']
  if (typeof content === 'object' && content !== null) {
    const nested = asText((content as Record<string, unknown>)['text'])
    if (nested !== null) return nested
  }
  return '（空消息）'
}

/** 工具调用参数：字符串（JSON 文本）尽量格式化，便于看清"结构"；截断或非法时原样返回 */
export function toolInputOf(event: EventLike): string {
  const raw = event.payload['input'] ?? event.payload['args']
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return ''
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      // 被截断（尾随 …）或本来就不是 JSON：原样显示
      return raw
    }
  }
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}

/**
 * 计划进度（`plan` 事件：`{planId, steps:[{step,title}], stepIndex, status}`）。
 * S44/D47：会话流里要把计划显示出来——它是"制定计划"与"执行第 N 步"之间**可见的分界**。
 */
function planInfo(event: EventLike): {
  readonly total: number
  readonly index: number
  readonly status: string
  readonly titles: readonly string[]
} {
  const steps = Array.isArray(event.payload['steps']) ? event.payload['steps'] : []
  const titles: string[] = []
  for (const raw of steps) {
    if (typeof raw === 'string') {
      titles.push(raw)
      continue
    }
    if (typeof raw === 'object' && raw !== null) {
      const title = (raw as Record<string, unknown>)['title']
      if (typeof title === 'string' && title.trim().length > 0) titles.push(title.trim())
    }
  }
  const rawIndex = event.payload['stepIndex']
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? rawIndex : 0
  const status = asText(event.payload['status']) ?? 'running'
  const total = titles.length === 0 ? Math.max(index, 1) : titles.length
  return { total, index, status, titles }
}

/** 非消息事件的正文（工具调用=参数、工具结果=结果文本、思考/错误=文本、计划=步骤清单） */
export function eventBody(event: EventLike): string {
  switch (event.kind) {
    case 'tool_call':
      return toolInputOf(event)
    case 'tool_result': {
      const summary =
        asText(event.payload['summary']) ?? asText(event.payload['text']) ?? asText(event.payload['result'])
      if (summary !== null) return summary
      break
    }
    case 'plan': {
      // 只有"计划刚产出"那一条（stepIndex=0 & running）带步骤清单；后续进度行只留一行标题
      const info = planInfo(event)
      const initial = info.index === 0 && info.status === 'running'
      if (!initial || info.titles.length === 0) return ''
      return info.titles.map((title, i) => `${i + 1}. ${title}`).join('\n')
    }
    case 'thought':
    case 'error': {
      const text = asText(event.payload['text']) ?? asText(event.payload['message'])
      if (text !== null) return text
      break
    }
    default:
      break
  }
  const generic = asText(event.payload['text']) ?? asText(event.payload['message']) ?? asText(event.payload['summary'])
  if (generic !== null) return generic
  return JSON.stringify(event.payload)
}

/** 事件标题（会话流每行的第一行文字） */
export function eventLabel(event: EventLike): string {
  switch (event.kind) {
    case 'plan': {
      // S44/D47：计划本身也要看得见——产出时给步数，之后给进度/结果
      const info = planInfo(event)
      if (info.status === 'done') return `计划完成 · ${info.total} 步`
      if (info.status === 'interrupted') return `计划已中断 · 第 ${info.index}/${info.total} 步`
      if (info.index === 0) return `计划（${info.total} 步）`
      return `计划进度 · 第 ${info.index}/${info.total} 步`
    }
    case 'thought': {
      // S43/D46：带上来源步骤（制定计划 / 执行第 N 步 / 汇总工具结果…）——
      // 否则 plan-execute 各步的思考在会话流里看起来就是"两条连着、看不出差别的思考"
      const purpose = asText(event.payload['purpose'])
      return purpose === null || purpose.trim().length === 0 ? '思考' : `思考 · ${purpose.trim()}`
    }
    case 'tool_call':
      return `工具调用 ${toolNameOf(event)}`
    case 'tool_result':
      // S26 用户口径：工具结果条目**只显示工具调用名称**（不显示"工具结果"字样、正文与序号）
      return toolNameOf(event)
    case 'error':
      return '错误'
    default:
      return event.kind
  }
}

export interface EventRow {
  /** 行标题 */
  readonly label: string
  /** 行正文；`null` = 该条目没有正文（工具结果成功时只有工具名） */
  readonly body: string | null
  /** 是否显示 `#seq · turn N` 次要信息（工具结果不显示） */
  readonly showMeta: boolean
  /**
   * 正文呈现方式：
   * - `inline` 直接展示（消息、含**工具报错内容**，S34）；
   * - `collapsed` **默认折叠**、点击展开（S28：工具调用参数；S41：思考）；
   * - `none` 没有正文。
   */
  readonly bodyMode: 'inline' | 'collapsed' | 'none'
}

/**
 * **一行怎么渲染**（唯一真相）：
 * - 消息 / 错误：标题 + 正文 + `#seq · turn N`（`inline`）；
 * - **思考：标题 + 正文默认折叠**（S41/D44，点击展开——S40 打开思考后每轮一条，正文很长会刷屏）；
 * - **工具调用：标题 + 参数默认折叠**（S28，点击展开看参数结构）；
 * - **工具结果：成功时只有工具名**（S26）；**失败时必须显示报错内容**（S34，见 `isToolFailed`）；
 * - 其它 kind：标题 = kind 名 + 正文（`inline`）。
 */
export function eventRow(event: EventLike): EventRow {
  if (event.kind === 'tool_result') {
    // S34 用户口径：工具报错要能看到**报错内容**（此前失败只是把名字标红，用户不知道错在哪）
    if (isToolFailed(event)) {
      const detail = eventBody(event)
      return {
        label: eventLabel(event),
        body: detail.length > 0 ? detail : null,
        showMeta: false,
        bodyMode: detail.length > 0 ? 'inline' : 'none',
      }
    }
    return { label: eventLabel(event), body: null, showMeta: false, bodyMode: 'none' }
  }
  const body = eventBody(event)
  // 空白正文按"没有正文"处理（否则会渲染出一个点开是空的折叠面板）
  const hasBody = body.trim().length > 0
  if (event.kind === 'tool_call' || event.kind === 'thought') {
    // S28：工具调用参数默认不展开；S41/D44：思考默认折叠（没有正文时退化为纯标题行）
    return { label: eventLabel(event), body: hasBody ? body : null, showMeta: true, bodyMode: hasBody ? 'collapsed' : 'none' }
  }
  return { label: eventLabel(event), body: hasBody ? body : null, showMeta: true, bodyMode: hasBody ? 'inline' : 'none' }
}

/** 时间戳 → **本地** `HH:MM:SS.mmm`（详细日志视图用；S39/D42：不再是 UTC 切片） */
export function shortTime(ts: string | undefined): string {
  return localClock(ts)
}

/**
 * **详细日志（trace）视图的一行**（S35）：头部 + 摘要，**覆盖全部 kind**（不像对话视图只挑四类）。
 * 用于"切换窗口看完整原始日志"：头部给 `#seq · 时间 · turn · kind`，摘要把 payload 说清。
 */
export function traceLine(event: EventLike): { readonly head: string; readonly text: string } {
  const head = `#${event.seq} · ${shortTime(event.ts)} · turn ${event.turn} · ${event.kind}`
  const payload = event.payload

  switch (event.kind) {
    case 'message': {
      const role = asText(payload['role']) ?? '?'
      return { head, text: `${role === 'user' ? '用户' : 'Agent'}：${messageTextOf(event)}` }
    }
    case 'thought': {
      // S43/D46：详细日志里也标出来源步骤
      const purpose = asText(payload['purpose'])
      const body = asText(payload['text']) ?? ''
      return { head, text: purpose === null || purpose.trim().length === 0 ? body : `${purpose.trim()}：${body}` }
    }
    case 'tool_call': {
      const input = toolInputOf(event)
      return { head, text: input.length === 0 ? toolNameOf(event) : `${toolNameOf(event)} ${input}` }
    }
    case 'tool_result': {
      const status = isToolFailed(event) ? '失败' : '成功'
      return { head, text: `${status} · ${toolNameOf(event)}：${eventBody(event)}` }
    }
    case 'turn_start': {
      const loopStep = asText(payload['loopStep']) ?? '—'
      const steps = payload['steps']
      return { head, text: `loop=${loopStep}${Array.isArray(steps) ? ` · plan ${steps.length} 步` : ''}` }
    }
    case 'turn_end': {
      const parts = [asText(payload['status']), asText(payload['reason'])].filter((part) => part !== null)
      return { head, text: parts.length === 0 ? '回合结束' : parts.join(' · ') }
    }
    case 'plan': {
      const status = asText(payload['status']) ?? '?'
      const steps = payload['steps']
      const index = typeof payload['stepIndex'] === 'number' ? payload['stepIndex'] : null
      return {
        head,
        text: `计划 ${status}${Array.isArray(steps) ? `（${steps.length} 步）` : ''}${index === null ? '' : ` · 当前第 ${index} 步`}`,
      }
    }
    case 'summary': {
      const range = [payload['ofSeq'], payload['toSeq']].filter((value) => typeof value === 'number')
      return { head, text: `${range.length === 2 ? `覆盖 seq ${range[0]}~${range[1]}：` : ''}${asText(payload['text']) ?? ''}` }
    }
    case 'artifact':
      return { head, text: `${asText(payload['title']) ?? asText(payload['artifactId']) ?? ''} v${payload['version'] ?? '?'}` }
    case 'approval_request':
      return { head, text: `${asText(payload['kind']) ?? ''} · ${asText(payload['summary']) ?? ''}` }
    case 'approval_result':
      return { head, text: `${asText(payload['decision']) ?? ''}${asText(payload['reason']) === null ? '' : ` · ${asText(payload['reason'])}`}` }
    case 'state':
      return { head, text: JSON.stringify(payload) }
    case 'error':
      return { head, text: asText(payload['text']) ?? asText(payload['message']) ?? JSON.stringify(payload) }
    default:
      return { head, text: asText(payload['text']) ?? asText(payload['message']) ?? JSON.stringify(payload) }
  }
}
