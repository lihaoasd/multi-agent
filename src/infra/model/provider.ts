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

/**
 * 流式增量单元：正文增量与推理增量分离。
 * - content：可见正文（既有 message.chunk 通道）；
 * - reasoning：模型思考/意图文本（DeepSeek reasoning_content 等；thought.chunk 通道 + thought 事件落盘）。
 * 二者可交替出现；无增量的一帧产出空对象，调用方按字段判断。
 */
export interface ChatStreamItem {
  content?: string
  reasoning?: string
}

export interface ModelProvider {
  id: string
  kind: 'mock' | 'openai-compatible' | 'ollama'
  /** 流式对话：yield 增量单元（正文 content / 推理 reasoning）。 */
  streamChat(
    opts: CompleteOptions & { baseUrl?: string; apiKey?: string; model?: string },
  ): AsyncIterable<ChatStreamItem>
}

export type { ModelsConfig }
