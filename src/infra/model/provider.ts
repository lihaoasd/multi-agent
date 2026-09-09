/**
 * 模型网关：provider 注册表 + 路由（agent-runtime.md §5）。
 * provider id → 实现；mock 内置可用，openai-compatible/ollama 走 HTTP（M8 真实模型验收启用）。
 * 流式：统一返回 AsyncIterable<string> 增量；非流式包装为一次性生成。
 */
import type { ModelsConfig } from '../../shared/config.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  providerId?: string
  model?: string
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface ModelProvider {
  id: string
  kind: 'mock' | 'openai-compatible' | 'ollama'
  /** 流式对话：yield 文本增量。 */
  streamChat(
    opts: CompleteOptions & { baseUrl?: string; apiKey?: string; model?: string },
  ): AsyncIterable<string>
}

export type { ModelsConfig }
