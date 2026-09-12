/**
 * OpenAI 兼容 API Provider（DeepSeek 等）：/chat/completions 流式。
 * 支持 function-calling：请求带 tools，解析 delta.tool_calls（按 index 分片）。
 * 无 Key/无 baseUrl 时抛 ERR_MODEL（不在测试默认路径）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ChatMessage, ModelProvider } from './provider.js'

/** 消息 → OpenAI wire 格式（tool 角色与 assistant.tool_calls 需专门字段）。 */
export function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

export function createOpenAiCompatibleProvider(id: string): ModelProvider {
  return {
    id,
    kind: 'openai-compatible',
    async *streamChat(opts) {
      if (!opts.baseUrl) throw new AppError(ErrorCodes.MODEL, `provider ${id} 缺少 baseUrl`)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
      const tools = opts.tools?.length
        ? opts.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model ?? id,
          messages: opts.messages.map(toWireMessage),
          stream: true,
          // 推理型模型（reasoning_content 先占预算）：给足 completion 预算，
          // 否则整轮预算被"思考"吃掉 → 只出推理不出正文/工具调用（角色看起来"没干活"）
          max_tokens: opts.maxTokens ?? 8192,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
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
              const j = JSON.parse(data) as {
                choices?: Array<{
                  delta?: {
                    content?: string
                    reasoning_content?: string
                    thinking?: string
                    tool_calls?: Array<{
                      index?: number
                      id?: string
                      function?: { name?: string; arguments?: string }
                    }>
                  }
                  finish_reason?: string
                }>
              }
              const choice = j.choices?.[0]
              const d = choice?.delta
              const content = d?.content
              // 推理型模型（DeepSeek reasoning_content / 部分兼容实现 thinking）：
              // 思考过程单独走 thought 通道，不入正文 history。
              const reasoning = d?.reasoning_content ?? d?.thinking
              if (content || reasoning) yield { content, reasoning }
              for (const tc of d?.tool_calls ?? []) {
                yield {
                  toolCall: {
                    index: tc.index ?? 0,
                    id: tc.id,
                    name: tc.function?.name,
                    argumentsDelta: tc.function?.arguments,
                  },
                }
              }
              // 结束原因（length=预算被截断）：调用方据此决定是否重试"少推理、直接输出"
              if (choice?.finish_reason) yield { finishReason: choice.finish_reason }
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
