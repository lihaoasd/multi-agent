/**
 * OpenAI 兼容 API Provider（DeepSeek 等）：/chat/completions 流式。
 * 无 Key/无 baseUrl 时抛 ERR_MODEL（不在测试默认路径）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ModelProvider } from './provider.js'

export function createOpenAiCompatibleProvider(id: string): ModelProvider {
  return {
    id,
    kind: 'openai-compatible',
    async *streamChat(opts) {
      if (!opts.baseUrl) throw new AppError(ErrorCodes.MODEL, `provider ${id} 缺少 baseUrl`)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model ?? id,
          messages: opts.messages,
          stream: true,
          max_tokens: opts.maxTokens,
        }),
        signal: opts.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AppError(ErrorCodes.MODEL, `模型 API 错误 ${res.status}: ${text.slice(0, 200)}`)
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
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const data = t.slice(5).trim()
            if (data === '[DONE]') return
            try {
              const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
              const delta = j.choices?.[0]?.delta?.content
              if (delta) yield delta
            } catch {
              // 忽略无法解析的中间帧
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}
