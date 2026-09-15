import type { ModelChunk, ModelRequest } from '../../../ports/model'
import type { ProviderKindAdapter, ProviderTestResult, ResolvedModel } from '../../../ports/model-config'
import { ok, type Result } from '../../../shared/result'

export interface MockAdapterOptions {
  /** 流式切片大小（字符） */
  readonly chunkSize?: number
  /** 每片延迟（毫秒），默认 0 */
  readonly delayMs?: number
  /** 可枚举的模型名 */
  readonly models?: readonly string[]
  /** 剧本：默认回声最后一条用户消息 */
  readonly reply?: (request: ModelRequest, resolved: ResolvedModel) => string
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('模型调用已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultReply(request: ModelRequest, resolved: ResolvedModel): string {
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
  const text = lastUser?.content ?? ''
  return `[mock:${resolved.entry.model}] 收到 ${request.messages.length} 条消息：${text}`
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Mock 适配器：无 Key 跑通全流程（prd §9 验收 2），并且是**适配器契约测试**的基准实现
 * （testing/plan.md 规则 31：五 kind 的归一化语义以同一套断言校验）。
 */
export function createMockAdapter(options: MockAdapterOptions = {}): ProviderKindAdapter {
  const chunkSize = Math.max(1, options.chunkSize ?? 12)
  const delayMs = options.delayMs ?? 0
  const models = options.models ?? ['mock']

  const buildReply = (request: ModelRequest, resolved: ResolvedModel): string =>
    options.reply?.(request, resolved) ?? defaultReply(request, resolved)

  return {
    kind: 'mock',
    capabilities: { stream: true, tools: true, reasoning: true },

    async stream(resolved: ResolvedModel, request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
      const reply = buildReply(request, resolved)
      const inputTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0)

      async function* generate(): AsyncGenerator<ModelChunk> {
        if (request.signal.aborted) throw new Error('模型调用已取消')
        for (let index = 0; index < reply.length; index += chunkSize) {
          await sleep(delayMs, request.signal)
          yield { type: 'text-delta', text: reply.slice(index, index + chunkSize) }
        }
        yield { type: 'usage', inputTokens, outputTokens: estimateTokens(reply) }
      }

      return ok(generate())
    },

    async listModels(): Promise<Result<readonly string[]> | null> {
      return ok(models)
    },

    async test(): Promise<Result<ProviderTestResult>> {
      return ok({ latencyMs: delayMs, models })
    },
  }
}
