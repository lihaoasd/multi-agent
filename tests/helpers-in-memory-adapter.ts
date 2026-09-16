import type { ModelChunk, ModelRequest } from '../src/ports/model'
import type { ProviderKindAdapter, ProviderTestResult, ResolvedModel } from '../src/ports/model-config'
import { ok, type Result } from '../src/shared/result'

/**
 * 测试替身：流式归一化的**基准实现**（`docs/testing/plan.md` 规则 31）。
 * 说明：S10 起产品面不再提供任何"假模型"供应商（mock 已彻底移除），
 * 该替身只存在于 `tests/`，用于验证适配器契约（分片增量、末尾 usage、取消即中断）。
 */

export interface InMemoryAdapterOptions {
  readonly chunkSize?: number
  readonly reply?: (request: ModelRequest) => string
  readonly models?: readonly string[]
  /** 需要注册到 kind 注册表时使用（默认 `ollama`，也是唯一免密钥的内置 kind） */
  readonly kind?: ProviderKindAdapter['kind']
}

function lastUserText(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === 'user')
  return last?.content ?? ''
}

export function createInMemoryAdapter(options: InMemoryAdapterOptions = {}): ProviderKindAdapter {
  const chunkSize = Math.max(1, options.chunkSize ?? 5)
  const reply = options.reply ?? ((request: ModelRequest) => `[in-memory:${request.model}] ${lastUserText(request)}`)
  const models = options.models ?? ['in-memory']

  return {
    kind: options.kind ?? 'ollama',
    capabilities: { stream: true, tools: true, reasoning: false },

    async stream(_resolved: ResolvedModel, request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
      const text = reply(request)
      const chunks: ModelChunk[] = []
      for (let index = 0; index < text.length; index += chunkSize) {
        chunks.push({ type: 'text-delta', text: text.slice(index, index + chunkSize) })
      }
      chunks.push({ type: 'usage', inputTokens: request.messages.length, outputTokens: text.length })
      return ok(
        (async function* () {
          for (const chunk of chunks) {
            if (request.signal.aborted) throw new Error('请求已取消')
            yield chunk
          }
        })(),
      )
    },

    async listModels(): Promise<Result<readonly string[]>> {
      return ok([...models])
    },

    async test(): Promise<Result<ProviderTestResult>> {
      return ok({ latencyMs: 0, models: [...models] })
    },
  }
}
