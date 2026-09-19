import type { Result } from '../shared/result'

/**
 * 模型调用端口（真源：docs/design/model-config.md §6/§12、abstraction.md §4.2/§4.6）。
 * 口径：`ModelRequest.model` 是**模型条目 id**（ModelId），不是供应商 id（D20-①）。
 */

export type ProviderId = string
export type ModelId = string

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'

export type ModelCapability = 'chat' | 'stream' | 'tools' | 'reasoning'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  readonly role: ChatRole
  readonly content: string
  /** 工具结果消息关联的调用 id（role=tool 时使用） */
  readonly toolCallId?: string
  /**
   * 该 assistant 消息的**思考内容**（S40/D43：DeepSeek 的 `reasoning_content`）。
   * 带 `tools` 的思考模式请求，后续轮次**必须回传**，否则 API 会 400；适配器按能力标记决定是否发送。
   */
  readonly reasoning?: string
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  /** JSON Schema（透传给供应商） */
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ModelRequest {
  readonly model: ModelId
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolSchema[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal: AbortSignal
}

/** 供应商差异在适配器内归一化为本联合类型（model-config.md §6.1） */
export type ModelChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly args: unknown }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }

export interface ModelInfo {
  readonly id: ModelId
  readonly providerId: ProviderId
  readonly model: string
  readonly displayName: string
  readonly capabilities: readonly ModelCapability[]
  readonly enabled: boolean
}

export interface ModelGateway {
  /** 统一流式：解析失败/调用失败一律以 ERR_MODEL 返回（detail 已脱敏） */
  stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>>
  listModels(): Promise<readonly ModelInfo[]>
}
