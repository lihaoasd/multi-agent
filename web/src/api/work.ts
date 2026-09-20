import { apiRequest } from './client'

/** 产出物 / 任务 / 询问（contract.md §2；S6） */

export type ArtifactType = 'doc' | 'code' | 'config' | 'test' | 'deploy'
export type ArtifactState = 'submitted' | 'approved' | 'rejected' | 'reverted'
export type TaskState = 'todo' | 'in_progress' | 'done' | 'blocked' | 'terminated'

export interface ArtifactRecord {
  readonly id: string
  readonly type: ArtifactType
  readonly title: string
  readonly summary: string
  readonly submitter: string
  readonly state: ArtifactState
  readonly version: number
  readonly files: readonly { readonly relPath: string; readonly action: 'add' | 'modify' | 'delete'; readonly hash: string }[]
  readonly diffSummary: { readonly add: number; readonly del: number }
  readonly prevVersion: number | null
  readonly taskId: string | null
  readonly revertedTo: number | null
  readonly ts: string
}

export interface FileOwnerRecord {
  readonly relPath: string
  readonly owner: string
  readonly ownerName: string
  readonly firstAt: string
  readonly lastAt: string
  readonly edits: number
  readonly lastTaskId: string | null
  readonly via: 'workdir_edit' | 'artifact_submit'
}

export interface TaskRecord {
  readonly id: string
  readonly title: string
  readonly desc: string
  readonly creator: string
  readonly assignee: string
  readonly state: TaskState
  readonly sessionId: string
  readonly artifactIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly note: string | null
}

export interface QuestionItemView {
  readonly id: string
  readonly text: string
  readonly options: readonly string[]
  readonly required: boolean
}

export interface QuestionRecord {
  readonly id: string
  readonly sessionId: string
  readonly asker: string
  readonly title: string
  readonly items: readonly QuestionItemView[]
  readonly status: 'pending' | 'answered'
  readonly answer: { readonly answers: readonly { readonly itemId: string; readonly choice: string | null; readonly text: string | null }[]; readonly decidedAt: string } | null
  readonly createdAt: string
  readonly answeredAt: string | null
}

export const workApi = {
  artifacts: (projectId: string, filter?: { type?: ArtifactType; taskId?: string; limit?: number }): Promise<ArtifactRecord[]> => {
    const params = new URLSearchParams()
    if (filter?.type !== undefined) params.set('type', filter.type)
    if (filter?.taskId !== undefined) params.set('taskId', filter.taskId)
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
    const query = params.toString()
    return apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/artifacts${query.length > 0 ? `?${query}` : ''}`)
  },
  artifactVersions: (projectId: string, artifactId: string): Promise<ArtifactRecord[]> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/versions`),
  rollback: (projectId: string, artifactId: string, version: number, force = false): Promise<ArtifactRecord> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/rollback`, {
      version,
      force,
    }),
  fileOwners: (projectId: string, owner?: string): Promise<FileOwnerRecord[]> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/file-owners${owner === undefined ? '' : `?owner=${encodeURIComponent(owner)}`}`,
    ),
  tasks: (projectId: string, filter?: { state?: TaskState; assignee?: string }): Promise<TaskRecord[]> => {
    const params = new URLSearchParams()
    if (filter?.state !== undefined) params.set('state', filter.state)
    if (filter?.assignee !== undefined) params.set('assignee', filter.assignee)
    const query = params.toString()
    return apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/tasks${query.length > 0 ? `?${query}` : ''}`)
  },
  createTask: (
    projectId: string,
    payload: { assignee: string; title: string; desc?: string; force?: boolean },
  ): Promise<{ task: TaskRecord; duplicate: boolean }> =>
    apiRequest('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks`, payload),
  setTaskState: (projectId: string, taskId: string, state: TaskState, note?: string): Promise<TaskRecord> =>
    apiRequest('PATCH', `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, {
      state,
      ...(note === undefined ? {} : { note }),
    }),
  questions: (projectId: string, status?: 'pending' | 'answered'): Promise<QuestionRecord[]> =>
    apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/questions${status === undefined ? '' : `?status=${status}`}`,
    ),
  answer: (
    projectId: string,
    questionId: string,
    answers: readonly { readonly itemId: string; readonly choice?: string | null; readonly text?: string | null }[],
  ): Promise<QuestionRecord> =>
    apiRequest(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}/answer`,
      { answers },
    ),
}
