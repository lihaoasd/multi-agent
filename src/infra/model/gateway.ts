/**
 * 模型网关：provider 解析 + 流式对话统一出口。
 * 路由（agent-runtime §5）：实例 model(providerId) → config providers 匹配 → mock 兜底。
 * openai-compatible/ollama 为 HTTP Provider（M8 真实模型验收启用；无 Key 时抛 ERR_MODEL）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ModelsConfig } from '../../shared/config.js'
import { createMockProvider } from './mock.js'
import { createOpenAiCompatibleProvider } from './openai-compatible.js'
import { createOllamaProvider } from './ollama.js'
import type { ChatMessage, ChatStreamItem, ToolSchema } from './provider.js'

export interface ModelGatewayOptions {
  models: ModelsConfig
  /** 取 API Key：默认读环境变量；测试可注入 */
  apiKeyResolver?: (envName: string) => string | undefined
}

export class ModelGateway {
  private readonly apiKeyResolver: (envName: string) => string | undefined

  constructor(private readonly opts: ModelGatewayOptions) {
    this.apiKeyResolver = opts.apiKeyResolver ?? ((n) => process.env[n])
  }

  /** 按 providerId 取 provider 配置（config.models.providers），无则 null。 */
  private findProvider(providerId: string) {
    return this.opts.models.providers.find((p) => p.id === providerId) ?? null
  }

  /** 流式对话：按 providerId（优先）或 models.default 路由，yield 增量单元。 */
  async *streamChat(opts: {
    providerId?: string
    messages: ChatMessage[]
    tools?: ToolSchema[]
    signal?: AbortSignal
  }): AsyncIterable<ChatStreamItem> {
    const providerId = opts.providerId && opts.providerId !== 'mock' ? opts.providerId : null
    const targetId =
      providerId ?? (this.opts.models.default !== 'mock' ? this.opts.models.default : 'mock')

    if (targetId === 'mock') {
      const mock = createMockProvider('mock')
      for await (const chunk of mock.streamChat({ messages: opts.messages, signal: opts.signal })) {
        yield chunk
      }
      return
    }

    const cfg = this.findProvider(targetId)
    if (!cfg) {
      throw new AppError(ErrorCodes.MODEL, `模型 provider 未配置: ${targetId}`)
    }
    const apiKey = cfg.apiKeyEnv ? this.apiKeyResolver(cfg.apiKeyEnv) : undefined
    if (cfg.kind === 'openai-compatible' && !apiKey) {
      throw new AppError(
        ErrorCodes.MODEL,
        `provider ${targetId} 缺少 API Key（环境变量 ${cfg.apiKeyEnv}）`,
      )
    }
    const provider =
      cfg.kind === 'ollama'
        ? createOllamaProvider(targetId)
        : createOpenAiCompatibleProvider(targetId)

    for await (const chunk of provider.streamChat({
      messages: opts.messages,
      tools: opts.tools,
      baseUrl: cfg.baseUrl,
      apiKey,
      model: cfg.model ?? targetId,
      signal: opts.signal,
    })) {
      yield chunk
    }
  }

  /** 非流式便利：聚合正文（忽略 reasoning）为完整文本。 */
  async complete(opts: {
    providerId?: string
    messages: ChatMessage[]
    tools?: ToolSchema[]
    signal?: AbortSignal
  }): Promise<string> {
    let out = ''
    for await (const item of this.streamChat(opts)) {
      if (item.content) out += item.content
    }
    return out
  }
}
