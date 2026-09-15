import { apiRequest } from './client'

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly workdir: string
  readonly workdirKind: 'empty' | 'existing-repo'
  readonly createdAt: string
  readonly updatedAt: string
  readonly memberCount: number
  readonly enabledCount: number
}

export interface RoleInstanceSnapshot {
  readonly roleTemplateId: string
  readonly templateName: string
  readonly systemPrompt: string
  readonly defaultModel: string | null
  readonly defaultLoop: { strategy: string; params: Record<string, unknown> }
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly defaultApprovalRules: readonly string[]
  readonly capturedAt: string
}

export interface ProjectMeta {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly workdir: string
  readonly workdirKind: 'empty' | 'existing-repo'
  readonly team: readonly {
    instanceId: string
    roleTemplateId: string
    displayName: string
    enabled: boolean
    configVersion: number
    snapshot: RoleInstanceSnapshot
  }[]
}

export interface InstanceView {
  readonly instanceId: string
  readonly roleTemplateId: string
  readonly displayName: string
  readonly templateName: string
  readonly templateMissing: boolean
  readonly enabled: boolean
  readonly configVersion: number
  readonly overrides: readonly string[]
  readonly effective: {
    readonly systemPrompt: string
    readonly model: string | null
    readonly loop: { strategy: string; params: Record<string, unknown> }
  }
  readonly effectiveModelLabel: string | null
  readonly effectiveModelAvailable: boolean
}

export interface BrowseEntry {
  readonly name: string
  readonly path: string
  readonly isDirectory: boolean
  readonly isRepo: boolean
  readonly hidden: boolean
}

export interface BrowseResult {
  readonly path: string | null
  readonly parent: string | null
  readonly entries: readonly BrowseEntry[]
  readonly truncated: boolean
}

export interface WorkdirInspection {
  readonly path: string
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly writable: boolean
  readonly entryCount: number
  readonly kind: 'empty' | 'existing-repo'
}

export interface InstancePatchInput {
  readonly displayName?: string
  readonly prompt?: string | null
  readonly model?: string | null
  readonly loop?: { strategy: string; params: Record<string, unknown> } | null
}

export const projectApi = {
  list: (): Promise<ProjectSummary[]> => apiRequest('GET', '/api/projects'),
  create: (input: {
    name: string
    description?: string
    workdir: string
    members?: readonly { roleTemplateId: string; displayName?: string }[]
  }): Promise<ProjectMeta> => apiRequest('POST', '/api/projects', input),
  get: (projectId: string): Promise<ProjectMeta> => apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}`),
  updateMeta: (projectId: string, patch: { name?: string; description?: string }): Promise<ProjectMeta> =>
    apiRequest('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, patch),
  remove: (projectId: string): Promise<void> =>
    apiRequest('DELETE', `/api/projects/${encodeURIComponent(projectId)}`),
  listTeam: (projectId: string): Promise<InstanceView[]> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/team`),
  addMember: (projectId: string, roleTemplateId: string): Promise<InstanceView> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/team`, { roleTemplateId }),
  patchInstance: (projectId: string, instanceId: string, patch: InstancePatchInput): Promise<InstanceView> =>
    apiRequest('PATCH', `/api/projects/${encodeURIComponent(projectId)}/team/${encodeURIComponent(instanceId)}`, patch),
  disableInstance: (projectId: string, instanceId: string): Promise<InstanceView> =>
    apiRequest('DELETE', `/api/projects/${encodeURIComponent(projectId)}/team/${encodeURIComponent(instanceId)}`),
  enableInstance: (projectId: string, instanceId: string): Promise<InstanceView> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/team/${encodeURIComponent(instanceId)}/enable`),
  browse: (path: string | null, includeHidden = false): Promise<BrowseResult> =>
    apiRequest(
      'GET',
      `/api/fs/browse?includeHidden=${includeHidden ? 'true' : 'false'}${path === null ? '' : `&path=${encodeURIComponent(path)}`}`,
    ),
  inspect: (path: string): Promise<WorkdirInspection> => apiRequest('POST', '/api/fs/inspect', { path }),
}
