import { apiRequest } from './client'

/** 运行控制与恢复（contract.md / agent-runtime.md §7；S8） */

export type RecoveryAction = 'report' | 'continue' | 'ignore' | 'complete'

export interface UnfinishedTurn {
  readonly sessionId: string
  readonly instanceId: string
  readonly turn: number
  readonly turnId: string | null
  readonly startedAt: string
  readonly loopStep: string | null
  readonly lastPlan: { readonly steps: number; readonly status: string | null } | null
  readonly resolvedBy: RecoveryAction | null
}

export interface RuntimeAgentView {
  readonly instanceId: string
  readonly displayName: string
  readonly state: 'idle' | 'working' | 'waiting'
  readonly paused: boolean
  readonly queued: number
  readonly sessionId: string
  readonly turn: number
  readonly startedAt: string | null
  readonly taskTitle: string | null
  readonly planStatus: string | null
  readonly unfinishedTurn: number | null
}

export interface RuntimeSnapshot {
  readonly projectId: string
  readonly working: readonly RuntimeAgentView[]
  readonly idle: number
  readonly paused: number
  readonly queuedTotal: number
}

export interface StopResult {
  readonly aborted: boolean
  readonly taskId: string | null
  readonly settledArtifactId: string | null
  readonly queued: number
}

export const runtimeApi = {
  snapshot: (projectId: string): Promise<RuntimeSnapshot> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/runtime`),
  stop: (projectId: string, instanceId: string, scope: 'turn' | 'task'): Promise<StopResult> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(instanceId)}/stop`, {
      scope,
    }),
  unfinished: (projectId: string): Promise<UnfinishedTurn[]> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/recovery`),
  sessionUnfinished: (projectId: string, sessionId: string): Promise<UnfinishedTurn | null> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/recovery`,
    ),
  resolve: (
    projectId: string,
    sessionId: string,
    turn: number,
    action: RecoveryAction,
  ): Promise<{ resumed: boolean; text: string }> =>
    apiRequest(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/recovery`,
      { turn, action },
    ),
  exportUrl: (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/export`,
}
