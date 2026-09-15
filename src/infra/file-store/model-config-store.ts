import type { RelPath } from '../../ports/file-store'
import type { FileStore } from '../../ports/file-store'
import {
  EMPTY_MODEL_CONFIG,
  type ConfigAuditEntry,
  type ConfigLoadNotice,
  type ModelConfigLoadResult,
  type ModelConfigStore,
  type ModelEntry,
  type ModelProviderConfig,
  type ModelRouting,
  type ModelConfigSnapshot,
} from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'

export interface ModelConfigStoreOptions {
  readonly fileStore: FileStore
  /** 配置文件相对路径（config.models.configFile，默认 data/model-config.json） */
  readonly path: RelPath
  /** 审计文件相对路径（默认 data/config-audit.jsonl） */
  readonly auditPath: RelPath
  readonly now?: () => Date
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseProvider(raw: unknown): ModelProviderConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = asString(record['id'])
  if (id.length === 0) return null
  const credentialRaw = record['credential']
  let credential: ModelProviderConfig['credential'] = { mode: 'file', value: '' }
  if (typeof credentialRaw === 'object' && credentialRaw !== null) {
    const c = credentialRaw as Record<string, unknown>
    if (c['mode'] === 'env') {
      credential = { mode: 'env', envName: asString(c['envName']) }
    } else {
      credential = { mode: 'file', value: asString(c['value']) }
    }
  }
  const headersRaw = record['headers']
  const headers =
    typeof headersRaw === 'object' && headersRaw !== null
      ? Object.fromEntries(
          Object.entries(headersRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined
  const timeoutMs = asNumber(record['timeoutMs'])
  return {
    id,
    name: asString(record['name'], id),
    kind: asString(record['kind'], 'openai-compatible') as ModelProviderConfig['kind'],
    baseUrl: asString(record['baseUrl']),
    credential,
    ...(headers === undefined ? {} : { headers }),
    enabled: asBoolean(record['enabled'], true),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    presetId: typeof record['presetId'] === 'string' ? (record['presetId'] as string) : null,
    createdAt: asString(record['createdAt'], new Date(0).toISOString()),
    updatedAt: asString(record['updatedAt'], new Date(0).toISOString()),
  }
}

function parseEntry(raw: unknown): ModelEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = asString(record['id'])
  const providerId = asString(record['providerId'])
  const model = asString(record['model'])
  if (id.length === 0 || providerId.length === 0 || model.length === 0) return null
  const capabilities = asStringArray(record['capabilities']).filter(
    (item): item is ModelEntry['capabilities'][number] =>
      item === 'chat' || item === 'stream' || item === 'tools' || item === 'reasoning',
  )
  const contextWindow = asNumber(record['contextWindow'])
  const maxOutputTokens = asNumber(record['maxOutputTokens'])
  const paramsRaw = record['defaultParams']
  const defaultParams =
    typeof paramsRaw === 'object' && paramsRaw !== null
      ? {
          ...(asNumber((paramsRaw as Record<string, unknown>)['temperature']) === undefined
            ? {}
            : { temperature: asNumber((paramsRaw as Record<string, unknown>)['temperature']) }),
          ...(asNumber((paramsRaw as Record<string, unknown>)['maxTokens']) === undefined
            ? {}
            : { maxTokens: asNumber((paramsRaw as Record<string, unknown>)['maxTokens']) }),
        }
      : undefined
  return {
    id,
    providerId,
    model,
    displayName: asString(record['displayName'], model),
    capabilities,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(defaultParams === undefined ? {} : { defaultParams }),
    enabled: asBoolean(record['enabled'], true),
    createdAt: asString(record['createdAt'], new Date(0).toISOString()),
    updatedAt: asString(record['updatedAt'], new Date(0).toISOString()),
  }
}

function parseRouting(raw: unknown): ModelRouting {
  if (typeof raw !== 'object' || raw === null) return { defaultModelId: null }
  const record = raw as Record<string, unknown>
  const defaultModelId = typeof record['defaultModelId'] === 'string' ? record['defaultModelId'] : null
  const overridesRaw = record['stepOverrides']
  const stepOverrides =
    typeof overridesRaw === 'object' && overridesRaw !== null
      ? Object.fromEntries(
          Object.entries(overridesRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined
  return { defaultModelId, ...(stepOverrides === undefined ? {} : { stepOverrides }) }
}

/** 严格解析：结构不合法（而非个别条目缺失）时视为坏文件 */
export function parseModelConfigSnapshot(raw: unknown): Result<ModelConfigSnapshot> {
  if (typeof raw !== 'object' || raw === null) {
    return err('ERR_VALIDATION', '模型配置不是对象')
  }
  const record = raw as Record<string, unknown>
  if (record['schemaVersion'] !== 1) {
    return err('ERR_VALIDATION', '模型配置 schemaVersion 不受支持', {
      schemaVersion: record['schemaVersion'],
    })
  }
  const providers = Array.isArray(record['providers'])
    ? record['providers'].map(parseProvider).filter((item): item is ModelProviderConfig => item !== null)
    : []
  const models = Array.isArray(record['models'])
    ? record['models'].map(parseEntry).filter((item): item is ModelEntry => item !== null)
    : []
  const revision = asNumber(record['revision']) ?? 0
  return ok({
    schemaVersion: 1,
    revision: Math.max(0, Math.floor(revision)),
    providers,
    models,
    routing: parseRouting(record['routing']),
  })
}

/** 遗留 v0 形状识别：`{ entries: [...], defaultModel }` 且无 schemaVersion */
export function isLegacyV0(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const record = raw as Record<string, unknown>
  return record['schemaVersion'] === undefined && Array.isArray(record['entries'])
}

/**
 * 平台模型配置存储（model-config.md §11 迁移口径）：
 * 文件缺失 → 空配置；JSON 坏 / v0 旧形状 → **备份**后按空配置启动，并把 notice 交给上层提示。
 */
export function createModelConfigStore(options: ModelConfigStoreOptions): ModelConfigStore {
  const { fileStore, path, auditPath } = options
  const now = options.now ?? (() => new Date())

  const backupPathFor = (suffix: string): string => {
    const base = path.endsWith('.json') ? path.slice(0, -'.json'.length) : path
    return `${base}.${suffix}.bak.json`
  }

  const backup = async (suffix: string): Promise<string> => {
    const backupPath = backupPathFor(suffix)
    const text = await fileStore.readText(path)
    if (text.ok) {
      await fileStore.writeTextAtomic(backupPath, text.value)
      await fileStore.remove(path)
    }
    return backupPath
  }

  const load = async (): Promise<Result<ModelConfigLoadResult>> => {
    const text = await fileStore.readText(path)
    if (!text.ok) {
      if (text.error.code === 'ERR_NOT_FOUND') {
        return ok({ snapshot: EMPTY_MODEL_CONFIG, notices: [] })
      }
      return text
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text.value)
    } catch {
      const backupPath = await backup('invalid')
      const notice: ConfigLoadNotice = { kind: 'invalid-file-backup', backupPath }
      return ok({ snapshot: EMPTY_MODEL_CONFIG, notices: [notice] })
    }

    if (isLegacyV0(parsed)) {
      const backupPath = await backup('v0')
      const notice: ConfigLoadNotice = { kind: 'legacy-v0-backup', backupPath }
      return ok({ snapshot: EMPTY_MODEL_CONFIG, notices: [notice] })
    }

    const snapshot = parseModelConfigSnapshot(parsed)
    if (!snapshot.ok) {
      const backupPath = await backup('invalid')
      const notice: ConfigLoadNotice = { kind: 'invalid-file-backup', backupPath }
      return ok({ snapshot: EMPTY_MODEL_CONFIG, notices: [notice] })
    }
    return ok({ snapshot: snapshot.value, notices: [] })
  }

  return {
    load,

    async save(next: ModelConfigSnapshot, expectedRevision: number): Promise<Result<ModelConfigSnapshot>> {
      const current = await load()
      if (!current.ok) return current
      if (current.value.snapshot.revision !== expectedRevision) {
        return err('ERR_CONFLICT', '模型配置已被其它写入方修改', {
          expectedRevision,
          actualRevision: current.value.snapshot.revision,
        })
      }
      const expectedHash = (await fileStore.hash(path)) ?? undefined
      const written: ModelConfigSnapshot = {
        ...next,
        schemaVersion: 1,
        revision: expectedRevision + 1,
      }
      const receipt = await fileStore.writeTextAtomic(
        path,
        `${JSON.stringify(written, null, 2)}\n`,
        expectedHash === undefined ? {} : { expectedHash },
      )
      if (!receipt.ok) return receipt
      return ok(written)
    },

    async appendAudit(entry: ConfigAuditEntry): Promise<Result<void>> {
      const record = { ...entry, ts: entry.ts.length > 0 ? entry.ts : now().toISOString() }
      return fileStore.appendLine(auditPath, JSON.stringify(record))
    },

    async loadLegacyV0(): Promise<Result<unknown | null>> {
      // 先读主文件；已被 load() 备份走时回退读 `.v0.bak.json`，保证"检测→提示→用户点导入"链路可用
      const candidates = [path, backupPathFor('v0')]
      for (const candidate of candidates) {
        const text = await fileStore.readText(candidate)
        if (!text.ok) continue
        try {
          const parsed: unknown = JSON.parse(text.value)
          if (isLegacyV0(parsed)) return ok(parsed)
        } catch {
          continue
        }
      }
      return ok(null)
    },
  }
}
