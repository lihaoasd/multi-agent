import { apiRequest } from './client'

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'

export interface CredentialView {
  readonly mode: 'file' | 'env'
  readonly envName?: string
  readonly hasValue: boolean
  readonly masked: string
}

export interface ProviderView {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credential: CredentialView
  readonly enabled: boolean
  readonly timeoutMs?: number
  readonly presetId: string | null
  readonly modelCount: number
}

export interface ModelView {
  readonly id: string
  readonly providerId: string
  readonly providerName: string
  readonly model: string
  readonly displayName: string
  readonly capabilities: readonly string[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly enabled: boolean
  readonly referrers: readonly string[]
}

export interface RoutingView {
  readonly defaultModelId: string | null
  readonly stepOverrides: Readonly<Record<string, string>>
}

export interface ModelPresetView {
  readonly presetId: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credentialHint: string
  readonly supportsModelDiscovery: boolean
  readonly docsUrl?: string
  readonly suggestedModels: readonly { model: string; displayName?: string; capabilities?: readonly string[] }[]
}

export interface CredentialInput {
  readonly mode: 'file' | 'env'
  readonly value?: string
  readonly envName?: string
}

export interface ProviderInput {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly credential?: CredentialInput
  readonly timeoutMs?: number
  readonly presetId?: string | null
}

export interface ModelInput {
  readonly id: string
  readonly providerId: string
  readonly model: string
  readonly displayName?: string
  readonly capabilities?: readonly string[]
}

export interface ProviderTestResult {
  readonly latencyMs: number
  readonly models?: readonly string[]
}

export interface UnconfiguredAgentRef {
  readonly projectId: string
  readonly projectName: string
  readonly instanceId: string
  readonly displayName: string
}

/** `/api/model-config/overview`：运行期总览（含"未配置模型"的 Agent，S11） */
export interface ModelConfigOverview {
  readonly revision: number
  readonly providers: readonly ProviderView[]
  readonly models: readonly ModelView[]
  readonly routing: RoutingView
  readonly notices: readonly { readonly kind: string; readonly backupPath?: string }[]
  readonly unconfiguredAgents: { readonly total: number; readonly items: readonly UnconfiguredAgentRef[] }
}

export const modelConfigApi = {
  listPresets: (): Promise<ModelPresetView[]> => apiRequest('GET', '/api/model-presets'),
  listProviders: (): Promise<ProviderView[]> => apiRequest('GET', '/api/model-providers'),
  createProvider: (input: Partial<ProviderInput> & { id?: string }): Promise<ProviderView> =>
    apiRequest('POST', '/api/model-providers', input),
  updateProvider: (id: string, patch: Partial<ProviderInput> & { enabled?: boolean }): Promise<ProviderView> =>
    apiRequest('PATCH', `/api/model-providers/${encodeURIComponent(id)}`, patch),
  deleteProvider: (id: string): Promise<{ deleted: string }> =>
    apiRequest('DELETE', `/api/model-providers/${encodeURIComponent(id)}`),
  testProvider: (id: string, mode: 'models' | 'chat', modelId?: string): Promise<ProviderTestResult> =>
    apiRequest('POST', `/api/model-providers/${encodeURIComponent(id)}/test`, {
      mode,
      ...(modelId === undefined ? {} : { modelId }),
    }),
  discoverModels: (id: string): Promise<{ models: string[] }> =>
    apiRequest('GET', `/api/model-providers/${encodeURIComponent(id)}/discover`),
  listModels: (): Promise<ModelView[]> => apiRequest('GET', '/api/models'),
  createModel: (input: ModelInput): Promise<ModelView> => apiRequest('POST', '/api/models', input),
  bulkCreateModels: (
    providerId: string,
    models: readonly { model: string; displayName?: string }[],
  ): Promise<{ created: string[]; skipped: string[] }> =>
    apiRequest('POST', '/api/models/bulk', { providerId, models }),
  updateModel: (id: string, patch: Record<string, unknown>): Promise<ModelView> =>
    apiRequest('PATCH', `/api/models/${encodeURIComponent(id)}`, patch),
  deleteModel: (id: string, confirm = false): Promise<{ deleted: string }> =>
    apiRequest('DELETE', `/api/models/${encodeURIComponent(id)}${confirm ? '?confirm=true' : ''}`),
  getRouting: (): Promise<RoutingView> => apiRequest('GET', '/api/model-routing'),
  putRouting: (routing: RoutingView): Promise<RoutingView> => apiRequest('PUT', '/api/model-routing', routing),
  /** 运行期总览：含"未配置模型的 Agent"（S11：一键设全局默认的依据） */
  overview: (): Promise<ModelConfigOverview> => apiRequest('GET', '/api/model-config/overview'),
  importLegacy: (source: 'env' | 'v0'): Promise<{ imported: number; skipped: string[] }> =>
    apiRequest('POST', `/api/model-config/import?source=${source}`),
}
