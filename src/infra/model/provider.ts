/**
 * 模型网关：provider 注册表 + 路由（agent-runtime.md §5）。
 * provider id → 实现；mock 内置可用，openai-compatible/ollama 走 HTTP（M8 真实模型验收启用）。
 * 流式：统一返回 AsyncIterable<ChatStreamItem> 增量（正文/推理/工具调用）；非流式包装为一次性生成。
 */
import type { ModelsConfig } from '../../shared/config.js'

export interface ChatToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串（由调用方解析） */
  arguments: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 请求的工具调用 */
  toolCalls?: ChatToolCall[]
  /** role='tool' 时对应的 toolCall.id */
  toolCallId?: string
}

/** 暴露给模型的工具定义（function-calling）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CompleteOptions {
  providerId?: string
  model?: string
  messages: ChatMessage[]
  /** 可用工具（为空则不启用 function-calling） */
  tools?: ToolSchema[]
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * 流式增量单元：正文增量、推理增量、工具调用增量。
 * - content：可见正文（既有 message.chunk 通道）；
 * - reasoning：模型思考/意图文本（thought.chunk 通道 + thought 事件落盘）；
 * - toolCall：function-calling 调用分片（按 index 归并，arguments 字符串拼接）。
 * 可交替出现；无增量的一帧产出空对象，调用方按字段判断。
 */
export interface ChatStreamItem {
  content?: string
  reasoning?: string
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string }
  /**
   * 结束原因（部分 provider 提供）：'length' = 输出预算被截断。
   * 推理型模型常见"思考吃满预算 → 没有正文/工具调用"，调用方据此重试。
   */
  finishReason?: string
}

export interface ModelProvider {
  id: string
  kind: 'mock' | 'openai-compatible' | 'ollama'
  /** 流式对话：yield 增量单元（正文 content / 推理 reasoning / 工具调用 toolCall）。 */
  streamChat(
    opts: CompleteOptions & { baseUrl?: string; apiKey?: string; model?: string },
  ): AsyncIterable<ChatStreamItem>
}

export type { ModelsConfig }
