/**
 * Ollama Provider：POST /api/chat 流式（原生 NDJSON）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ModelProvider } from './provider.js'

export function createOllamaProvider(id: string): ModelProvider {
  return {
    id,
    kind: 'ollama',
    async *streamChat(opts) {
      if (!opts.baseUrl) throw new AppError(ErrorCodes.MODEL, `provider ${id} 缺少 baseUrl`)
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? id,
          messages: opts.messages,
          stream: true,
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
                message?: { content?: string; reasoning_content?: string; thinking?: string }
                done?: boolean
              }
              const content = j.message?.content
              const reasoning = j.message?.reasoning_content ?? j.message?.thinking
              if (content || reasoning) yield { content, reasoning }
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
