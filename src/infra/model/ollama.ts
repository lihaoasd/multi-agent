/**
 * Ollama Provider：POST /api/chat 流式（原生 NDJSON）。
 * 支持 function-calling（tools 透传；message.tool_calls 归并为增量单元）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ChatMessage, ModelProvider } from './provider.js'

/** 消息 → Ollama wire 格式（tool 结果与 assistant.tool_calls）。 */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

export function createOllamaProvider(id: string): ModelProvider {
  return {
    id,
    kind: 'ollama',
    async *streamChat(opts) {
      if (!opts.baseUrl) throw new AppError(ErrorCodes.MODEL, `provider ${id} 缺少 baseUrl`)
      const tools = opts.tools?.length
        ? opts.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? id,
          messages: opts.messages.map(toWireMessage),
          stream: true,
          ...(tools ? { tools } : {}),
        }),
        signal: opts.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AppError(ErrorCodes.MODEL, `Ollama 错误 ${res.status}: ${text.slice(0, 200)}`)
      }
      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try {
              const j = JSON.parse(line) as {
                message?: {
                  content?: string
                  reasoning_content?: string
                  thinking?: string
                  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
                }
                done?: boolean
              }
              const content = j.message?.content
              const reasoning = j.message?.reasoning_content ?? j.message?.thinking
              if (content || reasoning) yield { content, reasoning }
              const calls = j.message?.tool_calls ?? []
              for (let i = 0; i < calls.length; i++) {
                yield {
                  toolCall: {
                    index: i,
                    name: calls[i]!.function?.name,
                    argumentsDelta: calls[i]!.function?.arguments,
                  },
                }
              }
              if (j.done) return
            } catch {
              // 跳过坏帧
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}
