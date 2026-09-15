import { apiRequest } from './client'

export type EventKind =
  | 'turn_start'
  | 'turn_end'
  | 'plan'
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_result'
  | 'artifact'
  | 'state'
  | 'summary'
  | 'error'

export interface SessionSummary {
  readonly sessionId: string
  readonly projectId: string
  readonly instanceId: string
  readonly displayName: string
  readonly state: string
  readonly lastSeq: number
  readonly updatedAt: string
  readonly lastMessagePreview: string | null
}

export interface StoredEvent {
  readonly seq: number
  readonly ts: string
  readonly sessionId: string
  readonly turn: number
  readonly kind: EventKind
  readonly payload: Record<string, unknown>
}

export interface SessionMeta {
  readonly id: string
  readonly projectId: string
  readonly state: string
  readonly lastSeq: number
  readonly segments: readonly { file: string; startSeq: number; endSeq: number; lines: number }[]
}

export interface AgentStatus {
  readonly instanceId: string
  readonly displayName: string
  readonly enabled: boolean
  readonly state: string
  readonly paused: boolean
  readonly queued: number
  readonly sessionId: string
}

export const sessionApi = {
  list: (projectId: string): Promise<SessionSummary[]> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/sessions`),
  detail: (projectId: string, sessionId: string, limit = 200): Promise<{ meta: SessionMeta; events: StoredEvent[] }> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`,
    ),
  log: (projectId: string, sessionId: string, opts?: { fromSeq?: number; kind?: string }): Promise<StoredEvent[]> => {
    const params = new URLSearchParams()
    if (opts?.fromSeq !== undefined) params.set('fromSeq', String(opts.fromSeq))
    if (opts?.kind !== undefined) params.set('kind', opts.kind)
    const query = params.toString()
    return apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/log${query.length > 0 ? `?${query}` : ''}`,
    )
  },
  send: (projectId: string, sessionId: string, text: string): Promise<{ seq: number; queued: boolean }> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
      text,
    }),
  status: (projectId: string): Promise<AgentStatus[]> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/agents`),
  pause: (projectId: string, instanceId: string): Promise<unknown> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(instanceId)}/pause`),
  resume: (projectId: string, instanceId: string): Promise<{ handled: number }> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(instanceId)}/resume`),
  resumeQueued: (projectId: string): Promise<{ resumed: string[] }> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/dispatcher/resume-queued`),
}
