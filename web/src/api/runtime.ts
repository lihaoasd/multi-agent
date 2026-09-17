import { apiRequest } from './client'

/**
 * 运行控制与导出（contract.md / agent-runtime.md §7；S8）。
 * ⚠️ S21/D27（2026-09-16）：`/recovery` 三条接口与「未完成回合」字段已删除——
 * 未完成回合不再由平台判定，改由 Agent 自查会话事件（工具 `session_recent`）后自行用 `ask_user` 询问用户。
 */

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
  exportUrl: (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/export`,
}
