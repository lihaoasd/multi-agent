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
  /** 提示词/loop 等身份字段可编辑（内置模板恒为 false） */
  readonly editable: boolean
  /** 默认模型可编辑（S11：内置模板也可改，经数据目录运行时覆盖） */
  readonly modelEditable: boolean
  /** 可删除（仅用户模板；内置模板只能停用） */
  readonly deletable: boolean
}

export interface TemplatePatch {
  readonly systemPrompt?: string
  readonly defaultLoop?: LoopConfig
  readonly defaultModel?: string | null
}

export interface BulkModelResult {
  readonly updated: readonly string[]
  readonly skipped: readonly { readonly roleId: string; readonly code: string; readonly message: string }[]
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
  /** 删除用户模板（`confirm` 二次确认；被项目引用 → 409 + referrers） */
  remove: (roleId: string, confirm = true): Promise<{ deleted: string }> =>
    apiRequest(
      'DELETE',
      `/api/agent-templates/${encodeURIComponent(roleId)}${confirm ? '?confirm=true' : ''}`,
    ),
  /** 一键批量设置默认模型（内置与用户模板均可；`null` = 清空默认模型） */
  bulkSetModel: (roleIds: readonly string[], defaultModel: string | null): Promise<BulkModelResult> =>
    apiRequest('POST', '/api/agent-templates/bulk-model', { roleIds, defaultModel }),
  history: (roleId: string): Promise<string[]> =>
    apiRequest('GET', `/api/agent-templates/${encodeURIComponent(roleId)}/history`),
}
