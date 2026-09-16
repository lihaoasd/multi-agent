import type { Clock } from '../../ports/clock'
import type { IdGenerator } from '../../ports/id'
import type {
  ConfigAuditAction,
  ConfigLoadNotice,
  ModelCatalog,
  ModelConfigSnapshot,
  ModelConfigStore,
  ModelEntry,
  ModelPreset,
  ModelPresetProvider,
  ModelProviderConfig,
  ProviderKindRegistry,
  ProviderTestResult,
  SecretResolver,
} from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'
import type { ConfigProvider } from '../../ports/config'
import {
  toModelView,
  toProviderView,
  toRoutingView,
  type ModelView,
  type ProviderView,
  type RoutingView,
} from './dto'
import type { ModelReferenceQuery } from './references'
import {
  ID_PATTERN,
  providerReferrers,
  validateModel,
  validateProvider,
  validateRouting,
  type ModelInput,
  type ModelReference,
  type ProviderInput,
} from './validate'

export interface ModelConfigServiceOptions {
  readonly store: ModelConfigStore
  readonly catalog: ModelCatalog
  readonly presets: ModelPresetProvider
  readonly kinds: ProviderKindRegistry
  readonly secrets: SecretResolver
  readonly references: ModelReferenceQuery
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
  /** 遗留 `.env` 的 MODELS__PROVIDERS 原始值读取（由 bootstrap 注入，application 不碰 node） */
  readonly readLegacyEnvProviders: () => unknown
}

export interface ProviderUpdateInput extends Partial<Omit<ProviderInput, 'id'>> {
  /** 省略 = 保持原凭证；传空 file 值 = 清除 */
  readonly id?: string
}

export interface ModelUpdateInput extends Partial<Omit<ModelInput, 'id'>> {
  readonly confirm?: boolean
}

export interface ModelConfigOverview {
  readonly revision: number
  readonly providers: readonly ProviderView[]
  readonly models: readonly ModelView[]
  readonly routing: RoutingView
  readonly notices: readonly ConfigLoadNotice[]
}

export interface ModelConfigService {
  listPresets(): readonly ModelPreset[]
  overview(): Promise<Result<ModelConfigOverview>>
  createProvider(input: ProviderInput): Promise<Result<ProviderView>>
  updateProvider(id: string, patch: ProviderUpdateInput): Promise<Result<ProviderView>>
  deleteProvider(id: string): Promise<Result<{ deleted: string }>>
  createModel(input: ModelInput): Promise<Result<ModelView>>
  updateModel(id: string, patch: ModelUpdateInput): Promise<Result<ModelView>>
  deleteModel(id: string, confirm: boolean): Promise<Result<{ deleted: string }>>
  bulkCreateModels(
    providerId: string,
    models: readonly ModelInput[],
  ): Promise<Result<{ created: readonly string[]; skipped: readonly string[] }>>
  updateRouting(routing: RoutingView): Promise<Result<RoutingView>>
  testProvider(id: string, opts: { mode: 'models' | 'chat'; modelId?: string }): Promise<Result<ProviderTestResult>>
  discoverModels(id: string): Promise<Result<readonly string[]>>
  importLegacy(source: 'env' | 'v0'): Promise<Result<{ imported: number; skipped: readonly string[] }>>
  ensureInitialized(): Promise<Result<{ imported: number }>>
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return /^[a-z0-9]/.test(slug) ? slug : `m-${slug}`.slice(0, 28)
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const candidate = ID_PATTERN.test(base) ? base : slugify(base)
  if (ID_PATTERN.test(candidate) && !taken.has(candidate)) return candidate
  for (let index = 2; index < 1000; index += 1) {
    const next = `${candidate.slice(0, 28)}-${index}`
    if (ID_PATTERN.test(next) && !taken.has(next)) return next
  }
  return `${slugify(base)}-${Date.now().toString(36)}`.slice(0, 32)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 模型配置服务（model-config.md §7/§8/§11）：校验 → 落盘 → 审计 → 缓存失效 */
export function createModelConfigService(options: ModelConfigServiceOptions): ModelConfigService {
  const { store, catalog, secrets, ids, clock, config } = options
  const platform = config.get()

  const nowIso = (): string => clock.now().toISOString()

  const audit = async (
    action: ConfigAuditAction,
    target: { kind: string; id: string },
    diff?: Readonly<Record<string, unknown>>,
    credentialTouched = false,
  ): Promise<void> => {
    await store.appendAudit({
      id: ids.next('cfg'),
      ts: nowIso(),
      actor: 'user',
      scope: 'platform',
      target,
      action,
      ...(diff === undefined ? {} : { diff }),
      credentialTouched,
    })
  }

  const loadSnapshot = async (): Promise<Result<ModelConfigSnapshot>> => {
    const loaded = await catalog.current()
    return loaded.ok ? ok(loaded.value.snapshot) : loaded
  }

  const commit = async (
    mutate: (snapshot: ModelConfigSnapshot) => Result<ModelConfigSnapshot>,
  ): Promise<Result<ModelConfigSnapshot>> => {
    const current = await loadSnapshot()
    if (!current.ok) return current
    const next = mutate(current.value)
    if (!next.ok) return next
    const saved = await store.save(next.value, current.value.revision)
    if (!saved.ok) return saved
    catalog.invalidate()
    return saved
  }

  const modelReferrers = async (modelId: string): Promise<readonly ModelReference[]> => {
    const fromTemplates = await options.references.findModelReferrers(modelId)
    const fromInstances = (await options.references.findInstancesReferrers?.(modelId)) ?? []
    return [...fromTemplates, ...fromInstances]
  }

  const buildOverview = async (
    snapshot: ModelConfigSnapshot,
    notices: readonly ConfigLoadNotice[],
  ): Promise<ModelConfigOverview> => {
    const referrerMap = new Map<string, string[]>()
    for (const entry of snapshot.models) {
      const refs = await modelReferrers(entry.id)
      referrerMap.set(
        entry.id,
        refs.map((ref) => `${ref.kind}:${ref.label ?? ref.id}`),
      )
    }
    const providerName = new Map(snapshot.providers.map((provider) => [provider.id, provider.name]))
    return {
      revision: snapshot.revision,
      providers: snapshot.providers.map((provider) =>
        toProviderView(
          provider,
          secrets,
          snapshot.models.filter((entry) => entry.providerId === provider.id).length,
        ),
      ),
      models: snapshot.models.map((entry) =>
        toModelView(entry, providerName.get(entry.providerId) ?? entry.providerId, referrerMap.get(entry.id) ?? []),
      ),
      routing: toRoutingView(snapshot.routing),
      notices,
    }
  }

  const providerOf = (snapshot: ModelConfigSnapshot, id: string): ModelProviderConfig | undefined =>
    snapshot.providers.find((provider) => provider.id === id)

  const service: ModelConfigService = {
    listPresets(): readonly ModelPreset[] {
      return options.presets.list()
    },

    async overview(): Promise<Result<ModelConfigOverview>> {
      const loaded = await catalog.current()
      if (!loaded.ok) return loaded
      return ok(await buildOverview(loaded.value.snapshot, loaded.value.notices))
    },

    async createProvider(input: ProviderInput): Promise<Result<ProviderView>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const validated = validateProvider(input, {
        snapshot: current.value,
        kinds: options.kinds.list(),
        secrets,
        isCreate: true,
        maxTimeoutMs: platform.models.requestTimeoutMs,
      })
      if (!validated.ok) return validated

      const stamped: ModelProviderConfig = { ...validated.value, createdAt: nowIso(), updatedAt: nowIso() }
      const saved = await commit((snapshot) => ok({ ...snapshot, providers: [...snapshot.providers, stamped] }))
      if (!saved.ok) return saved
      await audit('create', { kind: 'provider', id: stamped.id }, { fields: ['kind', 'baseUrl'] }, true)
      return ok(toProviderView(stamped, secrets, 0))
    },

    async updateProvider(id: string, patch: ProviderUpdateInput): Promise<Result<ProviderView>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const existing = providerOf(current.value, id)
      if (existing === undefined) {
        return err('ERR_NOT_FOUND', `供应商不存在：${id}`, { id })
      }
      const merged: ProviderInput = {
        id,
        name: patch.name ?? existing.name,
        kind: patch.kind ?? existing.kind,
        baseUrl: patch.baseUrl ?? existing.baseUrl,
        enabled: patch.enabled ?? existing.enabled,
        presetId: patch.presetId === undefined ? existing.presetId : patch.presetId,
        ...(patch.headers === undefined ? (existing.headers === undefined ? {} : { headers: existing.headers }) : { headers: patch.headers }),
        ...(patch.timeoutMs === undefined
          ? existing.timeoutMs === undefined
            ? {}
            : { timeoutMs: existing.timeoutMs }
          : { timeoutMs: patch.timeoutMs }),
        ...(patch.credential === undefined ? { credential: existing.credential } : { credential: patch.credential }),
      }
      const validated = validateProvider(merged, {
        snapshot: current.value,
        existing,
        kinds: options.kinds.list(),
        secrets,
        isCreate: false,
        maxTimeoutMs: platform.models.requestTimeoutMs,
      })
      if (!validated.ok) return validated

      const stamped: ModelProviderConfig = { ...validated.value, createdAt: existing.createdAt, updatedAt: nowIso() }
      const saved = await commit((snapshot) =>
        ok({
          ...snapshot,
          providers: snapshot.providers.map((provider) => (provider.id === id ? stamped : provider)),
        }),
      )
      if (!saved.ok) return saved
      await audit(
        'update',
        { kind: 'provider', id },
        { fields: Object.keys(patch).filter((key) => key !== 'credential') },
        patch.credential !== undefined,
      )
      return ok(
        toProviderView(
          stamped,
          secrets,
          current.value.models.filter((entry) => entry.providerId === id).length,
        ),
      )
    },

    async deleteProvider(id: string): Promise<Result<{ deleted: string }>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      if (providerOf(current.value, id) === undefined) {
        return err('ERR_NOT_FOUND', `供应商不存在：${id}`, { id })
      }
      const referrers = providerReferrers(current.value, id)
      if (referrers.length > 0) {
        return err('ERR_CONFLICT', '该供应商下仍有模型条目，无法删除', { referrers })
      }
      const saved = await commit((snapshot) =>
        ok({ ...snapshot, providers: snapshot.providers.filter((provider) => provider.id !== id) }),
      )
      if (!saved.ok) return saved
      await audit('delete', { kind: 'provider', id })
      return ok({ deleted: id })
    },

    async createModel(input: ModelInput): Promise<Result<ModelView>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const validated = validateModel(input, { snapshot: current.value, isCreate: true })
      if (!validated.ok) return validated
      const stamped: ModelEntry = { ...validated.value, createdAt: nowIso(), updatedAt: nowIso() }
      const saved = await commit((snapshot) => ok({ ...snapshot, models: [...snapshot.models, stamped] }))
      if (!saved.ok) return saved
      await audit('create', { kind: 'model', id: stamped.id }, { providerId: stamped.providerId })
      const provider = providerOf(current.value, stamped.providerId)
      return ok(toModelView(stamped, provider?.name ?? stamped.providerId))
    },

    async updateModel(id: string, patch: ModelUpdateInput): Promise<Result<ModelView>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const existing = current.value.models.find((entry) => entry.id === id)
      if (existing === undefined) {
        return err('ERR_NOT_FOUND', `模型条目不存在：${id}`, { id })
      }
      const validated = validateModel(
        {
          id,
          providerId: patch.providerId ?? existing.providerId,
          model: patch.model ?? existing.model,
          displayName: patch.displayName ?? existing.displayName,
          capabilities: patch.capabilities ?? existing.capabilities,
          ...(patch.contextWindow === undefined
            ? existing.contextWindow === undefined
              ? {}
              : { contextWindow: existing.contextWindow }
            : { contextWindow: patch.contextWindow }),
          ...(patch.maxOutputTokens === undefined
            ? existing.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: existing.maxOutputTokens }
            : { maxOutputTokens: patch.maxOutputTokens }),
          ...(patch.defaultParams === undefined
            ? existing.defaultParams === undefined
              ? {}
              : { defaultParams: existing.defaultParams }
            : { defaultParams: patch.defaultParams }),
          enabled: patch.enabled ?? existing.enabled,
        },
        { snapshot: current.value, existing, isCreate: false },
      )
      if (!validated.ok) return validated

      const willDisable = existing.enabled && validated.value.enabled === false
      if (willDisable) {
        const referrers = await modelReferrers(id)
        if (referrers.length > 0 && patch.confirm !== true) {
          return err('ERR_CONFLICT', '该模型被引用，停用前请确认（运行期将报 ERR_MODEL）', { referrers })
        }
      }

      const stamped: ModelEntry = { ...validated.value, createdAt: existing.createdAt, updatedAt: nowIso() }
      const saved = await commit((snapshot) =>
        ok({ ...snapshot, models: snapshot.models.map((entry) => (entry.id === id ? stamped : entry)) }),
      )
      if (!saved.ok) return saved
      await audit('update', { kind: 'model', id }, { fields: Object.keys(patch).filter((key) => key !== 'confirm') })
      const provider = providerOf(current.value, stamped.providerId)
      const referrers = await modelReferrers(id)
      return ok(
        toModelView(
          stamped,
          provider?.name ?? stamped.providerId,
          referrers.map((ref) => `${ref.kind}:${ref.label ?? ref.id}`),
        ),
      )
    },

    async deleteModel(id: string, confirm: boolean): Promise<Result<{ deleted: string }>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      if (!current.value.models.some((entry) => entry.id === id)) {
        return err('ERR_NOT_FOUND', `模型条目不存在：${id}`, { id })
      }
      const referrers = await modelReferrers(id)
      if (referrers.length > 0 && !confirm) {
        return err('ERR_CONFLICT', '该模型被模板或实例引用，无法删除', { referrers })
      }
      const saved = await commit((snapshot) => {
        const isDefault = snapshot.routing.defaultModelId === id
        const overrides = snapshot.routing.stepOverrides ?? {}
        const nextOverrides = Object.fromEntries(Object.entries(overrides).filter(([, modelId]) => modelId !== id))
        return ok({
          ...snapshot,
          models: snapshot.models.filter((entry) => entry.id !== id),
          routing: {
            defaultModelId: isDefault ? null : snapshot.routing.defaultModelId,
            ...(Object.keys(nextOverrides).length === 0 ? {} : { stepOverrides: nextOverrides }),
          },
        })
      })
      if (!saved.ok) return saved
      await audit('delete', { kind: 'model', id }, { referrers: referrers.length, forced: referrers.length > 0 })
      return ok({ deleted: id })
    },

    async bulkCreateModels(
      providerId: string,
      models: readonly ModelInput[],
    ): Promise<Result<{ created: readonly string[]; skipped: readonly string[] }>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      if (providerOf(current.value, providerId) === undefined) {
        return err('ERR_NOT_FOUND', `供应商不存在：${providerId}`, { providerId })
      }
      const taken = new Set(current.value.models.map((entry) => entry.id))
      const created: ModelEntry[] = []
      const skipped: string[] = []

      for (const input of models) {
        const modelName = input.model.trim()
        if (modelName.length === 0) continue
        if (current.value.models.some((entry) => entry.providerId === providerId && entry.model === modelName)) {
          skipped.push(modelName)
          continue
        }
        const id = uniqueId(`${providerId}-${slugify(modelName)}`, taken)
        taken.add(id)
        created.push({
          id,
          providerId,
          model: modelName,
          displayName: (input.displayName ?? modelName).trim() || modelName,
          capabilities: (input.capabilities ?? ['chat', 'stream']).filter(
            (item): item is ModelEntry['capabilities'][number] =>
              item === 'chat' || item === 'stream' || item === 'tools' || item === 'reasoning',
          ),
          enabled: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
      }

      if (created.length === 0) return ok({ created: [], skipped })

      const saved = await commit((snapshot) => ok({ ...snapshot, models: [...snapshot.models, ...created] }))
      if (!saved.ok) return saved
      await audit('create', { kind: 'model', id: providerId }, { batch: created.map((entry) => entry.id) })
      return ok({ created: created.map((entry) => entry.id), skipped })
    },

    async updateRouting(routing: RoutingView): Promise<Result<RoutingView>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const validated = validateRouting(
        { defaultModelId: routing.defaultModelId, ...(Object.keys(routing.stepOverrides).length === 0 ? {} : { stepOverrides: routing.stepOverrides }) },
        current.value,
      )
      if (!validated.ok) return validated
      const saved = await commit((snapshot) => ok({ ...snapshot, routing: validated.value }))
      if (!saved.ok) return saved
      await audit('update', { kind: 'routing', id: 'routing' }, { fields: ['defaultModelId', 'stepOverrides'] })
      return ok(toRoutingView(validated.value))
    },

    async testProvider(
      id: string,
      opts: { mode: 'models' | 'chat'; modelId?: string },
    ): Promise<Result<ProviderTestResult>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const provider = providerOf(current.value, id)
      if (provider === undefined) {
        return err('ERR_NOT_FOUND', `供应商不存在：${id}`, { id })
      }
      const adapter = options.kinds.get(provider.kind)
      if (adapter === undefined) {
        return err('ERR_VALIDATION', `未注册的协议 kind：${provider.kind}`, { kind: provider.kind })
      }
      const secret = secrets.resolve(provider.credential)
      if (!secret.ok) return secret
      if (adapter.test === undefined) {
        return err('ERR_MODEL', '该协议适配器不支持连通性测试', { kind: provider.kind })
      }
      const entry = opts.modelId === undefined ? undefined : current.value.models.find((item) => item.id === opts.modelId)
      if (opts.modelId !== undefined && entry === undefined) {
        return err('ERR_NOT_FOUND', `模型条目不存在：${opts.modelId}`, { modelId: opts.modelId })
      }
      const result = await adapter.test(provider, {
        mode: opts.mode,
        ...(entry === undefined ? {} : { entry }),
        apiKey: secret.value,
      })
      await audit('test', { kind: 'provider', id }, { mode: opts.mode, ok: result.ok })
      return result
    },

    async discoverModels(id: string): Promise<Result<readonly string[]>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const provider = providerOf(current.value, id)
      if (provider === undefined) {
        return err('ERR_NOT_FOUND', `供应商不存在：${id}`, { id })
      }
      const adapter = options.kinds.get(provider.kind)
      if (adapter === undefined || adapter.listModels === undefined) {
        return err('ERR_MODEL', '该供应商不支持列模型，请手工填写模型名', { kind: provider.kind })
      }
      const secret = secrets.resolve(provider.credential)
      if (!secret.ok) return secret
      const result = await adapter.listModels(provider, secret.value)
      if (result === null) {
        return err('ERR_MODEL', '该供应商不支持列模型，请手工填写模型名', { kind: provider.kind })
      }
      if (!result.ok) return result
      await audit('test', { kind: 'provider', id }, { mode: 'models', count: result.value.length })
      return result
    },

    async importLegacy(source: 'env' | 'v0'): Promise<Result<{ imported: number; skipped: readonly string[] }>> {
      const current = await loadSnapshot()
      if (!current.ok) return current
      const skipped: string[] = []
      const providers: ModelProviderConfig[] = []
      const models: ModelEntry[] = []
      const takenProviders = new Set(current.value.providers.map((provider) => provider.id))
      const takenModels = new Set(current.value.models.map((entry) => entry.id))
      let defaultModelId: string | null = null

      if (source === 'env') {
        const raw = options.readLegacyEnvProviders()
        const entries = Array.isArray(raw) ? raw : []
        for (const item of entries) {
          const record = asRecord(item)
          if (record === undefined) continue
          const id = asString(record['id'])
          const model = asString(record['model'])
          if (id.length === 0 || !ID_PATTERN.test(id)) {
            skipped.push(id.length === 0 ? '(缺 id)' : id)
            continue
          }
          if (takenProviders.has(id)) {
            skipped.push(id)
            continue
          }
          takenProviders.add(id)
          const envName = asString(record['apiKeyEnv'])
          providers.push({
            id,
            name: id,
            kind: (asString(record['kind']) || 'openai-compatible') as ModelProviderConfig['kind'],
            baseUrl: asString(record['baseUrl']),
            credential: { mode: 'env', envName },
            enabled: true,
            presetId: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          if (model.length > 0) {
            const modelId = uniqueId(model, takenModels)
            takenModels.add(modelId)
            models.push({
              id: modelId,
              providerId: id,
              model,
              displayName: model,
              capabilities: ['chat', 'stream', 'tools'],
              enabled: true,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
            defaultModelId ??= modelId
          }
        }
      } else {
        const raw = await store.loadLegacyV0()
        if (!raw.ok) return raw
        const record = asRecord(raw.value)
        const entries = Array.isArray(record?.['entries']) ? (record?.['entries'] as unknown[]) : []
        for (const item of entries) {
          const entry = asRecord(item)
          if (entry === undefined) continue
          const id = asString(entry['id'])
          if (id.length === 0 || !ID_PATTERN.test(id) || takenProviders.has(id)) {
            skipped.push(id.length === 0 ? '(缺 id)' : id)
            continue
          }
          takenProviders.add(id)
          providers.push({
            id,
            name: asString(entry['name']) || id,
            kind: 'openai-compatible',
            baseUrl: asString(entry['baseUrl']),
            credential: { mode: 'file', value: asString(entry['apiKey']) },
            enabled: true,
            presetId: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          const modelName = asString(entry['model']) || id
          const modelId = uniqueId(modelName, takenModels)
          takenModels.add(modelId)
          models.push({
            id: modelId,
            providerId: id,
            model: modelName,
            displayName: modelName,
            capabilities: ['chat', 'stream', 'tools'],
            enabled: true,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          defaultModelId ??= modelId
        }
        defaultModelId = asString(record?.['defaultModel']) || defaultModelId
      }

      if (providers.length === 0 && models.length === 0) {
        return ok({ imported: 0, skipped })
      }

      const saved = await commit((snapshot) =>
        ok({
          ...snapshot,
          providers: [...snapshot.providers, ...providers],
          models: [...snapshot.models, ...models],
          routing:
            snapshot.routing.defaultModelId === null && defaultModelId !== null
              ? { ...snapshot.routing, defaultModelId }
              : snapshot.routing,
        }),
      )
      if (!saved.ok) return saved
      await audit('import', { kind: 'provider', id: source }, {
        providers: providers.map((provider) => provider.id),
        models: models.map((entry) => entry.id),
        skipped,
      })
      return ok({ imported: providers.length + models.length, skipped })
    },

    async ensureInitialized(): Promise<Result<{ imported: number }>> {
      const current = await loadSnapshot()
      if (!current.ok) return current

      // ① 迁移：剔除**已不再注册的协议 kind**（含其模型条目）并清理指向它们的路由（model-config.md §11）
      //    场景：历史数据里有已删除的 kind（如 mock）。用注册表判定，未来删任何 kind 都自动生效。
      const knownKinds = new Set(options.kinds.list())
      const staleProviders = current.value.providers.filter((provider) => !knownKinds.has(provider.kind))
      if (staleProviders.length > 0) {
        const staleProviderIds = new Set(staleProviders.map((provider) => provider.id))
        const droppedModels = current.value.models.filter((entry) => staleProviderIds.has(entry.providerId))
        const droppedModelIds = new Set(droppedModels.map((entry) => entry.id))
        const saved = await commit((snapshot) => {
          const overrides = Object.fromEntries(
            Object.entries(snapshot.routing.stepOverrides ?? {}).filter(([, modelId]) => !droppedModelIds.has(modelId)),
          )
          return ok({
            ...snapshot,
            providers: snapshot.providers.filter((provider) => !staleProviderIds.has(provider.id)),
            models: snapshot.models.filter((entry) => !droppedModelIds.has(entry.id)),
            routing: {
              defaultModelId:
                snapshot.routing.defaultModelId !== null && droppedModelIds.has(snapshot.routing.defaultModelId)
                  ? null
                  : snapshot.routing.defaultModelId,
              ...(Object.keys(overrides).length === 0 ? {} : { stepOverrides: overrides }),
            },
          })
        })
        if (!saved.ok) return saved
        await audit('migrate', { kind: 'provider', id: 'unsupported-kind' }, {
          removedProviders: staleProviders.map((provider) => provider.id),
          removedModels: droppedModels.map((entry) => entry.id),
        })
      }

      const after = await loadSnapshot()
      if (!after.ok) return after
      if (after.value.providers.length > 0 || after.value.models.length > 0) {
        return ok({ imported: 0 })
      }

      // ② 出厂状态为**空配置**：仅按需导入遗留 `.env` 配置，**绝不自动创建任何供应商/模型**
      let imported = 0
      if (platform.models.importFromEnv) {
        const legacy = await service.importLegacy('env')
        if (!legacy.ok) return legacy
        imported = legacy.value.imported
      }

      // ③ `MODELS__DEFAULT` 生效：命中**已启用**的模型条目 → 设为平台默认
      //    口径：初始化阶段以 `MODELS__DEFAULT` 为准（覆盖导入时的"第一条即默认"临时值）；
      //    命中不到则保留导入结果或保持为空，**绝不静默换模型**（D20-⑥）。
      const configuredDefault = platform.models.defaultModelId.trim()
      if (configuredDefault.length > 0) {
        const snapshot = await loadSnapshot()
        if (!snapshot.ok) return snapshot
        const matched = snapshot.value.models.find((entry) => entry.id === configuredDefault && entry.enabled)
        if (matched !== undefined && snapshot.value.routing.defaultModelId !== matched.id) {
          const saved = await commit((value) =>
            ok({ ...value, routing: { ...value.routing, defaultModelId: matched.id } }),
          )
          if (!saved.ok) return saved
          await audit('migrate', { kind: 'routing', id: 'platform-default' }, { defaultModelId: matched.id })
        }
      }

      return ok({ imported })
    },
  }

  return service
}
