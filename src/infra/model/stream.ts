/**
 * 流式解析工具：把 fetch 的响应体统一成
 * - SSE 事件流（openai-compatible / anthropic / gemini）
 * - NDJSON 行流（ollama）
 * 数值/结构差异一律留在各自适配器内（model-config.md §6.1）。
 */

/** 逐块读取 Web 响应体（用 reader API，避免依赖 asyncIterator 的实现差异） */
export async function* readTextChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) yield decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** 按行切分（同时处理 \n 与 \r\n；末行无换行也会吐出） */
export async function* iterateLines(chunks: AsyncGenerator<string>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      yield line
      index = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, '')
}

export interface SseEvent {
  readonly event?: string
  /** 多行 data 以 \n 连接 */
  readonly data: string
}

/** SSE：以空行分隔事件，`event:` 指定类型，多条 `data:` 拼接 */
export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let eventName: string | undefined
  let dataLines: string[] = []
  for await (const line of iterateLines(readTextChunks(body))) {
    if (line.length === 0) {
      if (dataLines.length > 0 || eventName !== undefined) {
        yield eventName === undefined ? { data: dataLines.join('\n') } : { event: eventName, data: dataLines.join('\n') }
      }
      eventName = undefined
      dataLines = []
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
      continue
    }
    // 非 SSE 行（个别供应商会在流里夹带纯文本）：按 data 处理
    dataLines.push(line)
  }
  if (dataLines.length > 0 || eventName !== undefined) {
    yield eventName === undefined ? { data: dataLines.join('\n') } : { event: eventName, data: dataLines.join('\n') }
  }
}

/** NDJSON：每行一个 JSON 对象（空行跳过） */
export async function* iterateNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of iterateLines(readTextChunks(body))) {
    const trimmed = line.trim()
    if (trimmed.length > 0) yield trimmed
  }
}
