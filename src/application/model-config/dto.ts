import type { ModelCapability, ModelId, ProviderId, ProviderKind } from '../../ports/model'
import type { Credential, ModelEntry, ModelProviderConfig, SecretResolver } from '../../ports/model-config'

/** 凭证的**可外发**视图：只含掩码与"是否已配置"，永不含明文（model-config.md §5） */
export interface CredentialView {
  readonly mode: 'file' | 'env'
  readonly envName?: string
  readonly hasValue: boolean
  readonly masked: string
}

export function maskSecret(value: string): string {
  if (value.length === 0) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 3)}***${value.slice(-4)}`
}

export function toCredentialView(credential: Credential, secrets: SecretResolver): CredentialView {
  if (credential.mode === 'env') {
    const hasValue = secrets.has(credential)
    return {
      mode: 'env',
      envName: credential.envName,
      hasValue,
      masked: hasValue ? `env:${credential.envName}` : `env:${credential.envName}（未设置）`,
    }
  }
  return {
    mode: 'file',
    hasValue: credential.value.length > 0,
    masked: maskSecret(credential.value),
  }
}

export interface ProviderView {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credential: CredentialView
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled: boolean
  readonly timeoutMs?: number
  readonly presetId: string | null
  readonly modelCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

export function toProviderView(
  provider: ModelProviderConfig,
  secrets: SecretResolver,
  modelCount: number,
): ProviderView {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    credential: toCredentialView(provider.credential, secrets),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    enabled: provider.enabled,
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
    presetId: provider.presetId,
    modelCount,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}

export interface ModelView {
  readonly id: ModelId
  readonly providerId: ProviderId
  readonly providerName: string
  readonly model: string
  readonly displayName: string
  readonly capabilities: readonly ModelCapability[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly enabled: boolean
  readonly referrers: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export function toModelView(
  entry: ModelEntry,
  providerName: string,
  referrers: readonly string[] = [],
): ModelView {
  return {
    id: entry.id,
    providerId: entry.providerId,
    providerName,
    model: entry.model,
    displayName: entry.displayName,
    capabilities: entry.capabilities,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
    enabled: entry.enabled,
    referrers,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}
