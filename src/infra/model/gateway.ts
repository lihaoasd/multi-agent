import type { ModelChunk, ModelInfo, ModelRequest } from '../../ports/model'
import type { ModelCatalog, ProviderKindRegistry, ResolvedModel } from '../../ports/model-config'
import { AppFailure, err, ok, type Result } from '../../shared/result'
import { sanitizeForError } from './redact'

export interface ModelGatewayOptions {
  readonly catalog: ModelCatalog
  readonly kinds: ProviderKindRegistry
}

/**
 * 流式包装：流中途的错误无法再用 Result 表达，统一抛 `AppFailure(ERR_MODEL)`，
 * 且消息与 detail 中的密钥已脱敏；上层（S4 的 loop）捕获后落 `kind=error` 事件。
 */
async function* guardStream(
  source: AsyncIterable<ModelChunk>,
  resolved: ResolvedModel,
): AsyncGenerator<ModelChunk> {
  try {
    for await (const chunk of source) yield chunk
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new AppFailure({
      code: 'ERR_MODEL',
      message: `模型流式响应中断：${sanitizeForError(message, [resolved.apiKey])}`,
      detail: { providerId: resolved.provider.id, modelId: resolved.modelId },
    })
  }
}

/**
 * 模型网关（abstraction.md §4.2）：按**模型条目 id** 解析 → 选适配器 → 归一化流。
 * 失败一律 `ERR_MODEL`，**不静默回退到其它模型**（D20-⑥）。
 */
export function createModelGateway(options: ModelGatewayOptions): {
  stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>>
  listModels(): Promise<readonly ModelInfo[]>
} {
  return {
    async stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
      const resolved = await options.catalog.resolve(request.model)
      if (!resolved.ok) return resolved

      const adapter = options.kinds.get(resolved.value.kind)
      if (adapter === undefined) {
        return err('ERR_MODEL', `未注册的协议适配器：${resolved.value.kind}`, {
          providerId: resolved.value.provider.id,
          modelId: resolved.value.modelId,
        })
      }

      const streamed = await adapter.stream(resolved.value, request)
      if (!streamed.ok) return streamed
      return ok(guardStream(streamed.value, resolved.value))
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      return options.catalog.listModels()
    },
  }
}
