import type { Result } from '../shared/result'
import type {
  ModelCapability,
  ModelChunk,
  ModelId,
  ModelInfo,
  ModelRequest,
  ProviderId,
  ProviderKind,
} from './model'

/**
 * 模型配置端口（真源：docs/design/model-config.md）。
 * 分层口径：**供应商（连接）→ 模型条目（具体模型）→ Agent 引用模型条目 id**。
 * 凭证安全：`credential` 明文只存在于本层与适配器内部，**不得进入日志/接口响应/审计**。
 */

// ── 配置数据模型（model-config.md §3~§4）─────────────────────────────
export type Credential =
  | { readonly mode: 'file'; readonly value: string }
  | { readonly mode: 'env'; readonly envName: string }

export interface ModelProviderConfig {
  readonly id: ProviderId
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credential: Credential
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled: boolean
  readonly timeoutMs?: number
  readonly presetId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ModelEntry {
  readonly id: ModelId
  readonly providerId: ProviderId
  /** 传给后端的真实模型名（火山方舟为推理接入点 id） */
  readonly model: string
  readonly displayName: string
  readonly capabilities: readonly ModelCapability[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly defaultParams?: {
    readonly temperature?: number
    readonly maxTokens?: number
    /** 思考强度（S40/D43）：openai-compatible（DeepSeek/OpenAI 系）映射为 `reasoning_effort`，缺省 `high` */
    readonly reasoningEffort?: 'low' | 'high' | 'max'
    /** 思考预算（S40/D43）：anthropic `thinking.budget_tokens` / gemini `thinkingBudget` */
    readonly thinkingBudget?: number
  }
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ModelConfigSnapshot {
  readonly schemaVersion: 1
  readonly revision: number
  readonly providers: readonly ModelProviderConfig[]
  readonly models: readonly ModelEntry[]
}

export const EMPTY_MODEL_CONFIG: ModelConfigSnapshot = {
  schemaVersion: 1,
  revision: 0,
  providers: [],
  models: [],
}

// ── 审计（model-config.md §10）───────────────────────────────────────
export type ConfigAuditScope = 'platform' | 'template' | 'instance'
export type ConfigAuditAction = 'create' | 'update' | 'delete' | 'test' | 'import' | 'migrate'

export interface ConfigAuditEntry {
  readonly id: string
  readonly ts: string
  readonly actor: 'user' | 'system'
  readonly scope: ConfigAuditScope
  readonly target: { readonly kind: string; readonly id: string }
  readonly action: ConfigAuditAction
  /** 只记字段名与摘要：**不含密钥明文与提示词全文** */
  readonly diff?: Readonly<Record<string, unknown>>
  readonly credentialTouched?: boolean
  readonly projectId?: string
  readonly instanceId?: string
}

// ── 存储端口 ─────────────────────────────────────────────────────────
export type ConfigLoadNotice =
  | { readonly kind: 'legacy-v0-backup'; readonly backupPath: string }
  | { readonly kind: 'invalid-file-backup'; readonly backupPath: string }
  /** S14：已删除的「默认路由」（`routing`）字段在加载时被丢弃，待启动流程回写并审计 */
  | { readonly kind: 'routing-removed' }

export interface ModelConfigLoadResult {
  readonly snapshot: ModelConfigSnapshot
  readonly notices: readonly ConfigLoadNotice[]
}

export interface ConfigAuditWriter {
  appendAudit(entry: ConfigAuditEntry): Promise<Result<void>>
}

export interface ModelConfigStore extends ConfigAuditWriter {
  load(): Promise<Result<ModelConfigLoadResult>>
  /** 全量保存 + revision 乐观并发（不符 → ERR_CONFLICT） */
  save(next: ModelConfigSnapshot, expectedRevision: number): Promise<Result<ModelConfigSnapshot>>
  /** 遗留 v0（`{entries, defaultModel}`）读取：仅迁移用，不做自动导入 */
  loadLegacyV0(): Promise<Result<unknown | null>>
}

// ── 凭证解析（env 模式需要读进程环境，属 infra）──────────────────────
export interface SecretResolver {
  /** file 模式直接返回值；env 模式读环境变量，缺失 → ERR_VALIDATION */
  resolve(credential: Credential): Result<string | null>
  /** 仅用于"变量是否存在"校验，不返回值 */
  has(credential: Credential): boolean
}

// ── 协议适配器（model-config.md §6.1）───────────────────────────────
export interface ResolvedModel {
  readonly modelId: ModelId
  readonly provider: ModelProviderConfig
  readonly entry: ModelEntry
  readonly kind: ProviderKind
  readonly apiKey: string | null
  readonly timeoutMs: number
}

export interface ProviderTestResult {
  readonly latencyMs: number
  readonly models?: readonly string[]
}

export interface ProviderKindAdapter {
  readonly kind: ProviderKind
  readonly capabilities: { readonly stream: boolean; readonly tools: boolean; readonly reasoning: boolean }
  stream(resolved: ResolvedModel, request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>>
  /** 供应商支持的模型名列表；不支持则返回 null（UI 允许手工填写） */
  listModels?(provider: ModelProviderConfig, apiKey: string | null): Promise<Result<readonly string[]> | null>
  test?(
    provider: ModelProviderConfig,
    opts: { readonly mode: 'models' | 'chat'; readonly entry?: ModelEntry; readonly apiKey: string | null },
  ): Promise<Result<ProviderTestResult>>
}

export interface ProviderKindRegistry {
  register(adapter: ProviderKindAdapter): void
  get(kind: ProviderKind): ProviderKindAdapter | undefined
  list(): readonly ProviderKind[]
}

// ── 目录解析（modelId → 可用连接信息）──────────────────────────────
export interface ModelCatalog {
  /** 当前快照 + 迁移提示（服务层与路由共用，避免重复读盘） */
  current(): Promise<Result<ModelConfigLoadResult>>
  snapshot(): Promise<Result<ModelConfigLoadResult>>
  resolve(modelId: ModelId): Promise<Result<ResolvedModel>>
  listModels(): Promise<readonly ModelInfo[]>
  /** 配置写入后调用：丢弃缓存，下一次调用即用新配置（即时生效，不重启） */
  invalidate(): void
}

// ── 内置预置目录（src/shared/model-presets.yaml）────────────────────
export interface ModelPresetModel {
  readonly model: string
  readonly displayName?: string
  readonly capabilities?: readonly ModelCapability[]
}

export interface ModelPreset {
  readonly presetId: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credentialHint: string
  readonly suggestedModels: readonly ModelPresetModel[]
  readonly docsUrl?: string
  /** 供应商是否支持列模型（火山方舟为 false，模型名=推理接入点 id） */
  readonly supportsModelDiscovery: boolean
}

export interface ModelPresetProvider {
  list(): readonly ModelPreset[]
}
