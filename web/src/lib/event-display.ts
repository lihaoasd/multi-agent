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

export interface EventLike {
  readonly kind: string
  readonly seq: number
  readonly turn: number
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

/** 非消息事件的正文（工具调用=参数、工具结果=结果文本、思考/错误=文本） */
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
    case 'thought':
      return '思考'
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
  /** 行正文；`null` = 该条目没有正文（工具结果：只显示工具名） */
  readonly body: string | null
  /** 是否显示 `#seq · turn N` 次要信息（工具结果不显示） */
  readonly showMeta: boolean
  /**
   * 正文呈现方式：
   * - `inline` 直接展示；
   * - `collapsed` **默认折叠**、点击展开（S28：工具调用参数）；
   * - `none` 没有正文。
   */
  readonly bodyMode: 'inline' | 'collapsed' | 'none'
}

/**
 * **一行怎么渲染**（唯一真相）：
 * - 思考 / 错误：标题 + 正文 + `#seq · turn N`（`inline`）；
 * - **工具调用：标题 + 参数默认折叠**（S28，点击展开看参数结构）；
 * - **工具结果：只有工具名**（S26，失败时由调用方标红，不加任何文字）；
 * - 其它 kind：标题 = kind 名 + 正文（`inline`）。
 */
export function eventRow(event: EventLike): EventRow {
  if (event.kind === 'tool_result') {
    return { label: eventLabel(event), body: null, showMeta: false, bodyMode: 'none' }
  }
  const body = eventBody(event)
  if (event.kind === 'tool_call') {
    // S28 用户口径：参数默认不展开（没有参数时退化为纯标题行）
    return { label: eventLabel(event), body: body.length > 0 ? body : null, showMeta: true, bodyMode: body.length > 0 ? 'collapsed' : 'none' }
  }
  return { label: eventLabel(event), body: body.length > 0 ? body : null, showMeta: true, bodyMode: body.length > 0 ? 'inline' : 'none' }
}
