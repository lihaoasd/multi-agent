import { apiRequest } from './client'

export interface LoopConfig {
  readonly strategy: string
  readonly params: Readonly<Record<string, unknown>>
}

export interface AgentTemplateView {
  readonly roleId: string
  readonly name: string
  readonly category: string
  readonly scenario: string
  readonly description: string
  readonly systemPrompt: string
  readonly defaultModel: string | null
  readonly defaultModelLabel: string | null
  readonly defaultModelAvailable: boolean
  readonly defaultLoop: LoopConfig
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly defaultApprovalRules: readonly string[]
  readonly source: 'builtin' | 'user'
  readonly enabled: boolean
  readonly copyFrom?: string
  readonly editable: boolean
}

export interface TemplatePatch {
  readonly systemPrompt?: string
  readonly defaultLoop?: LoopConfig
  readonly defaultModel?: string | null
}

export const agentTemplateApi = {
  list: (scenario?: string): Promise<AgentTemplateView[]> =>
    apiRequest('GET', `/api/agent-templates${scenario === undefined ? '' : `?scenario=${encodeURIComponent(scenario)}`}`),
  get: (roleId: string): Promise<AgentTemplateView> =>
    apiRequest('GET', `/api/agent-templates/${encodeURIComponent(roleId)}`),
  create: (input: {
    roleId: string
    copyFrom: string
    name?: string
    systemPrompt?: string
    defaultLoop?: LoopConfig
    defaultModel?: string
  }): Promise<AgentTemplateView> => apiRequest('POST', '/api/agent-templates', input),
  update: (roleId: string, patch: TemplatePatch): Promise<AgentTemplateView> =>
    apiRequest('PATCH', `/api/agent-templates/${encodeURIComponent(roleId)}`, patch),
  setEnabled: (roleId: string, enabled: boolean): Promise<AgentTemplateView> =>
    apiRequest('POST', `/api/agent-templates/${encodeURIComponent(roleId)}/${enabled ? 'enable' : 'disable'}`),
  history: (roleId: string): Promise<string[]> =>
    apiRequest('GET', `/api/agent-templates/${encodeURIComponent(roleId)}/history`),
}
