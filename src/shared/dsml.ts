/**
 * DSML 文本工具调用兼容（S30，纯函数，无依赖）。
 *
 * 背景：DeepSeek 系模型有自己的「用文本写工具调用」协议（DSML）。正常情况下服务端会把它转换成
 * 结构化 `tool_calls`；但**只要请求里没带 `tools`**（我们此前在"拿到工具结果后的追问"里漏传了），
 * 模型就只能在正文里把调用"写"出来，于是 DSML 与结论文本混在同一条消息里。
 *
 * 本模块负责：从模型正文里**提取** DSML 工具调用（→ 交给正常工具链执行），并把 DSML 片段从
 * 正文中**剥离**，避免脏文本落进会话。识别不了的 DSML 片段也会被剥离并计入 `unparsed`。
 *
 * 支持形态（大小写与全角竖线都容错）：
 * ```
 * <||DSML|| tool_calls>
 *   <||DSML|| invoke name="ask_user">
 *     <||DSML|| parameter name="title" string="false">…</||DSML|| parameter>
 *   </||DSML|| invoke>
 * </||DSML|| tool_calls>
 * ```
 */

export interface DsmlToolCall {
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

export interface DsmlExtraction {
  /** 剥离 DSML 之后的正文（可能为空） */
  readonly text: string
  readonly calls: readonly DsmlToolCall[]
  /** 看起来像 DSML 但解析失败的片段数（用于诊断；这些片段同样已从正文剥离） */
  readonly unparsed: number
}

/** DSML 片段是否出现（用于快速判断与日志；全角竖线也算） */
export function hasDsml(text: string): boolean {
  return /<\s*[|｜]*\s*DSML\s*[|｜]*\s*(tool_calls|invoke|parameter)\b/i.test(text)
}

function normalizeMarkup(text: string): string {
  // 全角竖线/空格差异归一，便于用一套正则处理
  return text.replace(/｜/g, '|')
}

const CALLS_BLOCK = /<\s*\|+\s*DSML\s*\|+\s*tool_calls\s*>([\s\S]*?)<\s*\/\s*\|+\s*DSML\s*\|+\s*tool_calls\s*>/gi
const INVOKE_BLOCK = /<\s*\|+\s*DSML\s*\|+\s*invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\s*\/\s*\|+\s*DSML\s*\|+\s*invoke\s*>/gi
const PARAMETER_BLOCK =
  /<\s*\|+\s*DSML\s*\|+\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*\|+\s*DSML\s*\|+\s*parameter\s*>/gi
/** 任何残留的 DSML 标签（解析失败时兜底剔除，避免脏文本进会话） */
const ANY_DSML_TAG = /<\s*\/?\s*\|+\s*DSML\s*\|+[^>]*>/gi

function parseParameterValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/**
 * 从正文里提取 DSML 工具调用。
 * - `{ text, calls, unparsed }`：`text` 是剥离后的正文；`calls` 可直接并入本轮的 toolCalls；
 * - 完全没有 DSML 时原样返回（`calls` 为空、`unparsed` 为 0），调用方据此走快路径。
 */
export function extractDsmlToolCalls(input: string): DsmlExtraction {
  const normalized = normalizeMarkup(input)
  if (!hasDsml(normalized)) return { text: input, calls: [], unparsed: 0 }

  const calls: DsmlToolCall[] = []
  let unparsed = 0

  const collectInvokes = (chunk: string): number => {
    INVOKE_BLOCK.lastIndex = 0
    let invoke: RegExpExecArray | null
    let count = 0
    while ((invoke = INVOKE_BLOCK.exec(chunk)) !== null) {
      count += 1
      const name = (invoke[1] ?? '').trim()
      const args: Record<string, unknown> = {}
      PARAMETER_BLOCK.lastIndex = 0
      let parameter: RegExpExecArray | null
      while ((parameter = PARAMETER_BLOCK.exec(invoke[2] ?? '')) !== null) {
        args[(parameter[1] ?? '').trim()] = parseParameterValue(parameter[2] ?? '')
      }
      if (name.length > 0) {
        calls.push({ callId: `dsml_${calls.length + 1}`, name, args })
      } else {
        unparsed += 1
      }
    }
    return count
  }

  CALLS_BLOCK.lastIndex = 0
  let block: RegExpExecArray | null
  let foundBlock = false
  while ((block = CALLS_BLOCK.exec(normalized)) !== null) {
    foundBlock = true
    if (collectInvokes(block[1] ?? '') === 0) unparsed += 1
  }
  // 容错：模型偶尔省略外层 `tool_calls` 包裹，只剩裸 invoke —— 也认
  if (!foundBlock && collectInvokes(normalized) === 0) unparsed += 1

  const text = normalized.replace(ANY_DSML_TAG, '').replace(/\n{3,}/g, '\n\n').trim()
  return { text, calls, unparsed }
}
