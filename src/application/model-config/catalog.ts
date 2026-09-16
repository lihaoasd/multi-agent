import type { Clock } from '../../ports/clock'
import type { ModelInfo } from '../../ports/model'
import type {
  ModelCatalog,
  ModelConfigLoadResult,
  ModelConfigSnapshot,
  ModelConfigStore,
  ModelEntry,
  ModelProviderConfig,
  ResolvedModel,
  SecretResolver,
} from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'

export interface ModelCatalogOptions {
  readonly store: ModelConfigStore
  readonly secrets: SecretResolver
  readonly clock: Clock
  /** 平台请求超时上限（config.models.requestTimeoutMs） */
  readonly defaultTimeoutMs: number
}

/**
 * 模型目录：`modelId → 可用连接信息`（model-config.md §12）。
 * 缓存策略：按 `revision` 判定，写入后调用 `invalidate()`；不存在"半生效"状态。
 */
export function createModelCatalog(options: ModelCatalogOptions): ModelCatalog {
  let cached: ModelConfigLoadResult | null = null

  const current = async (): Promise<Result<ModelConfigLoadResult>> => {
    if (cached !== null) return ok(cached)
    const loaded = await options.store.load()
    if (!loaded.ok) return loaded
    cached = loaded.value
    return loaded
  }

  const findEntry = (snapshot: ModelConfigSnapshot, modelId: string): ModelEntry | undefined =>
    snapshot.models.find((entry) => entry.id === modelId)

  const findProvider = (snapshot: ModelConfigSnapshot, providerId: string): ModelProviderConfig | undefined =>
    snapshot.providers.find((provider) => provider.id === providerId)

  return {
    current,

    async snapshot(): Promise<Result<ModelConfigLoadResult>> {
      return current()
    },

    async resolve(modelId: string): Promise<Result<ResolvedModel>> {
      const loaded = await current()
      if (!loaded.ok) return loaded
      const { snapshot } = loaded.value

      const entry = findEntry(snapshot, modelId)
      if (entry === undefined) {
        return err('ERR_MODEL', `模型条目不存在：${modelId}`, { modelId })
      }
      if (!entry.enabled) {
        return err('ERR_MODEL', `模型条目已停用：${modelId}`, { modelId, providerId: entry.providerId })
      }

      const provider = findProvider(snapshot, entry.providerId)
      if (provider === undefined) {
        return err('ERR_MODEL', `模型条目引用的供应商不存在：${entry.providerId}`, {
          modelId,
          providerId: entry.providerId,
        })
      }
      if (!provider.enabled) {
        return err('ERR_MODEL', `供应商已停用：${provider.name}`, {
          modelId,
          providerId: provider.id,
        })
      }
      if (provider.baseUrl.trim().length === 0) {
        return err('ERR_MODEL', `供应商未配置 baseUrl：${provider.name}`, {
          modelId,
          providerId: provider.id,
        })
      }

      const secret = options.secrets.resolve(provider.credential)
      if (!secret.ok) return secret

      return ok({
        modelId: entry.id,
        provider,
        entry,
        kind: provider.kind,
        apiKey: secret.value,
        timeoutMs: Math.min(provider.timeoutMs ?? options.defaultTimeoutMs, options.defaultTimeoutMs),
      })
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      const loaded = await current()
      if (!loaded.ok) return []
      return loaded.value.snapshot.models.map((entry) => ({
        id: entry.id,
        providerId: entry.providerId,
        model: entry.model,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
        enabled: entry.enabled,
      }))
    },

    invalidate(): void {
      cached = null
    },
  }
}
