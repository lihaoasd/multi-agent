import type { Result } from '../shared/result'
import type { TaskState } from '../shared/artifacts'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 任务端口（真源：docs/design/data-storage.md §7、prd US-13/US-14、D19-⑤）。
 * `tasks.jsonl` 为 append-only：同 id 的后续行是状态变更，读取时取最后一条。
 */

export interface TaskRecord {
  readonly id: string
  readonly title: string
  readonly desc: string
  /** `user`（用户经 UI 派单）或上游 Agent 的 instanceId（沿编排图出边委派，D19-④） */
  readonly creator: string
  readonly assignee: InstanceId
  readonly state: TaskState
  readonly sessionId: SessionId
  readonly artifactIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly note: string | null
}

export interface TaskListFilter {
  readonly state?: TaskState
  readonly assignee?: InstanceId
  readonly creator?: string
  readonly limit?: number
}

export interface TaskStore {
  create(projectId: ProjectId, record: TaskRecord): Promise<Result<TaskRecord>>
  update(projectId: ProjectId, record: TaskRecord): Promise<Result<TaskRecord>>
  list(projectId: ProjectId, filter?: TaskListFilter): Promise<Result<readonly TaskRecord[]>>
  get(projectId: ProjectId, taskId: string): Promise<Result<TaskRecord>>
}

export interface CreateTaskInput {
  readonly projectId: ProjectId
  readonly title: string
  readonly desc: string
  readonly creator: string
  readonly assignee: InstanceId
  readonly sessionId: SessionId
  /** 同 assignee + 归一化标题 + 活跃状态视为同一件事；force=true 强制新建 */
  readonly force?: boolean
}

export interface TaskService {
  create(input: CreateTaskInput): Promise<Result<{ readonly task: TaskRecord; readonly duplicate: boolean }>>
  /** 受派人领取（todo → in_progress）；每 Agent 至多 1 个 in_progress */
  claim(projectId: ProjectId, taskId: string, assignee: InstanceId): Promise<Result<TaskRecord>>
  /** 汇报/干预：done/blocked/terminated；置 in_progress 受"单 in_progress"约束 */
  setState(
    projectId: ProjectId,
    taskId: string,
    state: TaskState,
    options?: { readonly actor?: string; readonly note?: string },
  ): Promise<Result<TaskRecord>>
  list(projectId: ProjectId, filter?: TaskListFilter): Promise<Result<readonly TaskRecord[]>>
  get(projectId: ProjectId, taskId: string): Promise<Result<TaskRecord>>
  /** 上下文注入用：该 Agent 当前 `in_progress` 任务（todo 不入上下文，规则 15） */
  activeFor(projectId: ProjectId, instanceId: InstanceId): Promise<Result<TaskRecord | null>>
}
