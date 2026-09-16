import type { ModelCapability, ProviderKind } from '../../ports/model'
import type {
  Credential,
  ModelConfigSnapshot,
  ModelEntry,
  ModelProviderConfig,
  SecretResolver,
} from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'

/** 供应商 / 模型条目 id 规则（model-config.md §8 #1） */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

const CAPABILITY_VALUES: readonly ModelCapability[] = ['chat', 'stream', 'tools', 'reasoning']

export function validateId(id: string, label: string): Result<string> {
  if (!ID_PATTERN.test(id)) {
    return err('ERR_VALIDATION', `${label} id 不合法（小写字母/数字/连字符，2~32 位）：${id}`, { id })
  }
  return ok(id)
}

export function validateBaseUrl(baseUrl: string, kind: ProviderKind): Result<string> {
  const trimmed = baseUrl.trim()
  if (trimmed.length === 0) {
    return err('ERR_VALIDATION', 'baseUrl 不能为空', { kind })
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return err('ERR_VALIDATION', 'baseUrl 必须是 http(s) 地址', { baseUrl: trimmed })
  }
  return ok(trimmed)
}

export function validateCredential(
  credential: Credential,
  secrets: SecretResolver,
  opts: { readonly isCreate: boolean; readonly kind: ProviderKind },
): Result<Credential> {
  if (opts.kind === 'ollama') {
    // 本地后端允许无凭证
    return ok(credential)
  }
  if (credential.mode === 'env') {
    if (credential.envName.trim().length === 0) {
      return err('ERR_VALIDATION', 'env 模式必须提供环境变量名')
    }
    if (!secrets.has(credential)) {
      return err('ERR_VALIDATION', `环境变量 ${credential.envName} 不存在或为空`, {
        envName: credential.envName,
      })
    }
    return ok({ mode: 'env', envName: credential.envName.trim() })
  }
  if (opts.isCreate && credential.value.trim().length === 0) {
    return err('ERR_VALIDATION', 'file 模式必须填写密钥')
  }
  return ok({ mode: 'file', value: credential.value })
}

export interface ProviderInput {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credential?: Credential
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled?: boolean
  readonly timeoutMs?: number
  readonly presetId?: string | null
}

export interface ProviderValidationContext {
  readonly snapshot: ModelConfigSnapshot
  readonly existing?: ModelProviderConfig
  readonly kinds: readonly ProviderKind[]
  readonly secrets: SecretResolver
  readonly isCreate: boolean
  readonly maxTimeoutMs: number
}

/** 供应商校验（§8 #1~#5）：返回**归一化后**的供应商配置 */
export function validateProvider(
  input: ProviderInput,
  ctx: ProviderValidationContext,
): Result<ModelProviderConfig> {
  const id = validateId(input.id, '供应商')
  if (!id.ok) return id
  if (ctx.isCreate && ctx.snapshot.providers.some((provider) => provider.id === input.id)) {
    return err('ERR_CONFLICT', `供应商 id 已存在：${input.id}`, { id: input.id })
  }
  if (!ctx.kinds.includes(input.kind)) {
    return err('ERR_VALIDATION', `未注册的协议 kind：${input.kind}`, { available: ctx.kinds })
  }
  if (input.name.trim().length === 0) {
    return err('ERR_VALIDATION', '供应商名称不能为空')
  }
  const baseUrl = validateBaseUrl(input.baseUrl, input.kind)
  if (!baseUrl.ok) return baseUrl

  const credential =
    input.credential ?? ctx.existing?.credential ?? (input.kind === 'ollama'
      ? ({ mode: 'file', value: '' } as const)
      : undefined)
  if (credential === undefined) {
    return err('ERR_VALIDATION', '必须提供凭证（file 明文 或 env 环境变量）')
  }
  const validatedCredential = validateCredential(credential, ctx.secrets, {
    isCreate: ctx.isCreate,
    kind: input.kind,
  })
  if (!validatedCredential.ok) return validatedCredential

  const timeoutMs = input.timeoutMs ?? ctx.existing?.timeoutMs
  if (timeoutMs !== undefined && (timeoutMs < 1000 || timeoutMs > ctx.maxTimeoutMs)) {
    return err('ERR_VALIDATION', `timeoutMs 必须在 1000~${ctx.maxTimeoutMs} 之间`, { timeoutMs })
  }

  return ok({
    id: input.id,
    name: input.name.trim(),
    kind: input.kind,
    baseUrl: baseUrl.value,
    credential: validatedCredential.value,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    enabled: input.enabled ?? ctx.existing?.enabled ?? true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    presetId: input.presetId === undefined ? (ctx.existing?.presetId ?? null) : input.presetId,
    createdAt: ctx.existing?.createdAt ?? new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  })
}

export interface ModelInput {
  readonly id: string
  readonly providerId: string
  readonly model: string
  readonly displayName?: string
  readonly capabilities?: readonly string[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly defaultParams?: { readonly temperature?: number; readonly maxTokens?: number }
  readonly enabled?: boolean
}

export interface ModelValidationContext {
  readonly snapshot: ModelConfigSnapshot
  readonly existing?: ModelEntry
  readonly isCreate: boolean
}

/** 模型条目校验（§8 #6~#7） */
export function validateModel(input: ModelInput, ctx: ModelValidationContext): Result<ModelEntry> {
  const id = validateId(input.id, '模型条目')
  if (!id.ok) return id
  if (ctx.isCreate && ctx.snapshot.models.some((entry) => entry.id === input.id)) {
    return err('ERR_CONFLICT', `模型条目 id 已存在：${input.id}`, { id: input.id })
  }
  const provider = ctx.snapshot.providers.find((item) => item.id === input.providerId)
  if (provider === undefined) {
    return err('ERR_VALIDATION', `供应商不存在：${input.providerId}`, { providerId: input.providerId })
  }
  if (!provider.enabled) {
    return err('ERR_VALIDATION', `供应商已停用：${provider.id}`, { providerId: provider.id })
  }
  const modelName = input.model.trim()
  if (modelName.length === 0) {
    return err('ERR_VALIDATION', 'model（真实模型名）不能为空')
  }
  const duplicated = ctx.snapshot.models.some(
    (entry) =>
      entry.providerId === input.providerId && entry.model === modelName && entry.id !== ctx.existing?.id,
  )
  if (duplicated) {
    return err('ERR_CONFLICT', `同一供应商下已存在同名模型：${modelName}`, { providerId: input.providerId })
  }
  const capabilities = (input.capabilities ?? ctx.existing?.capabilities ?? ['chat', 'stream']).filter(
    (item): item is ModelCapability => CAPABILITY_VALUES.includes(item as ModelCapability),
  )
  const temperature = input.defaultParams?.temperature ?? ctx.existing?.defaultParams?.temperature
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    return err('ERR_VALIDATION', 'temperature 必须在 0~2 之间', { temperature })
  }

  return ok({
    id: input.id,
    providerId: input.providerId,
    model: modelName,
    displayName: (input.displayName ?? ctx.existing?.displayName ?? modelName).trim() || modelName,
    capabilities,
    ...(input.contextWindow === undefined
      ? ctx.existing?.contextWindow === undefined
        ? {}
        : { contextWindow: ctx.existing.contextWindow }
      : { contextWindow: input.contextWindow }),
    ...(input.maxOutputTokens === undefined
      ? ctx.existing?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: ctx.existing.maxOutputTokens }
      : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.defaultParams === undefined
      ? ctx.existing?.defaultParams === undefined
        ? {}
        : { defaultParams: ctx.existing.defaultParams }
      : { defaultParams: input.defaultParams }),
    enabled: input.enabled ?? ctx.existing?.enabled ?? true,
    createdAt: ctx.existing?.createdAt ?? new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  })
}

export interface ModelReference {
  readonly kind: 'model' | 'template' | 'instance'
  readonly id: string
  readonly label?: string
}

/** 供应商的被引用情况（§8 #8：其下存在模型条目即拒绝删除） */
export function providerReferrers(snapshot: ModelConfigSnapshot, providerId: string): readonly ModelReference[] {
  return snapshot.models
    .filter((entry) => entry.providerId === providerId)
    .map((entry) => ({ kind: 'model' as const, id: entry.id, label: entry.displayName }))
}
