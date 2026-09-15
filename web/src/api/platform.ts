import { apiRequest } from './client'

export interface ApprovalView {
  readonly id: string
  readonly projectId: string
  readonly kind: 'command' | 'submit' | 'rollback'
  readonly actor: string
  readonly sessionId: string
  readonly summary: string
  readonly detail: string
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired'
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly reason: string | null
}

export interface ToolPackageView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly required: boolean
  readonly riskMax: string
  readonly network: string
  readonly source: string
  readonly tools: readonly { readonly name: string; readonly registered: boolean }[]
}

export interface ToolView {
  readonly name: string
  readonly package: string
  readonly description: string
  readonly risk: string
  readonly network: string
  readonly needsApproval: boolean
  readonly idempotent: boolean
  readonly availableIn: readonly string[]
}

export interface PromptPreviewView {
  readonly sessionType: string
  readonly blocks: readonly { readonly id: string; readonly origin: string; readonly title: string; readonly text: string }[]
  readonly text: string
}

export const approvalApi = {
  list: (projectId: string, status?: string): Promise<ApprovalView[]> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/approvals${status === undefined ? '' : `?status=${encodeURIComponent(status)}`}`,
    ),
  decide: (projectId: string, approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<ApprovalView> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/decide`, {
      decision,
      ...(reason === undefined ? {} : { reason }),
    }),
}

export const toolApi = {
  packages: (): Promise<ToolPackageView[]> => apiRequest('GET', '/api/tool-packages'),
  tools: (): Promise<ToolView[]> => apiRequest('GET', '/api/tools'),
  loops: (): Promise<Array<{ name: string; description: string }>> => apiRequest('GET', '/api/loops'),
}

export const promptPreviewApi = {
  preview: (projectId: string, instanceId: string): Promise<PromptPreviewView> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(instanceId)}/system-prompt`,
    ),
}
