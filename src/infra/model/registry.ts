import type { ProviderKind } from '../../ports/model'
import type { ProviderKindAdapter, ProviderKindRegistry } from '../../ports/model-config'
import { createAnthropicAdapter } from './providers/anthropic'
import { createGeminiAdapter } from './providers/gemini'
import { createOllamaAdapter } from './providers/ollama'
import { createOpenAiCompatibleAdapter } from './providers/openai-compatible'

/** 协议 kind 注册表（model-config.md §6.1）：新增一种 kind = 注册一个适配器，不改上层 */
export function createProviderKindRegistry(): ProviderKindRegistry {
  const adapters = new Map<ProviderKind, ProviderKindAdapter>()
  return {
    register(adapter: ProviderKindAdapter): void {
      if (adapters.has(adapter.kind)) {
        throw new Error(`ERR_INTERNAL: 协议适配器重复注册：${adapter.kind}`)
      }
      adapters.set(adapter.kind, adapter)
    },
    get(kind: ProviderKind): ProviderKindAdapter | undefined {
      return adapters.get(kind)
    },
    list(): readonly ProviderKind[] {
      return [...adapters.keys()]
    },
  }
}

/** 内置四种 kind（ollama 为本地服务，其余四种均需真实供应商凭证） */
export function registerBuiltinProviderKinds(registry: ProviderKindRegistry): void {
  const builtin: readonly ProviderKindAdapter[] = [
    createOpenAiCompatibleAdapter(),
    createAnthropicAdapter(),
    createGeminiAdapter(),
    createOllamaAdapter(),
  ]
  for (const adapter of builtin) registry.register(adapter)
}
