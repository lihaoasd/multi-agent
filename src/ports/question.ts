import type { Result } from '../shared/result'
import type { QuestionStatus } from '../shared/artifacts'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 询问端口（真源：docs/design/data-storage.md §7、tools.md §4、D19-⑦）。
 * Agent → 用户提问：落 `questions.jsonl`（append-only，同 id 取最后一条），
 * 调用即 Agent `waiting`；同一 Agent 至多 1 个 pending（否则 `ERR_QUESTION_PENDING`）。
 */

export interface QuestionItem {
  readonly id: string
  readonly text: string
  readonly options: readonly string[]
  readonly required: boolean
}

export interface QuestionAnswer {
  readonly itemId: string
  readonly choice: string | null
  readonly text: string | null
}

export interface QuestionRecord {
  readonly id: string
  readonly sessionId: SessionId
  readonly asker: InstanceId
  readonly title: string
  readonly items: readonly QuestionItem[]
  readonly status: QuestionStatus
  readonly answer: { readonly answers: readonly QuestionAnswer[]; readonly decidedAt: string } | null
  readonly createdAt: string
  readonly answeredAt: string | null
}

export interface QuestionListFilter {
  readonly status?: QuestionStatus
  readonly sessionId?: SessionId
  readonly limit?: number
}

export interface QuestionStore {
  create(projectId: ProjectId, record: QuestionRecord): Promise<Result<QuestionRecord>>
  answer(
    projectId: ProjectId,
    questionId: string,
    answers: readonly QuestionAnswer[],
  ): Promise<Result<QuestionRecord>>
  list(projectId: ProjectId, filter?: QuestionListFilter): Promise<Result<readonly QuestionRecord[]>>
  get(projectId: ProjectId, questionId: string): Promise<Result<QuestionRecord>>
  hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean>
}

export interface QuestionService {
  ask(input: {
    readonly projectId: ProjectId
    readonly sessionId: SessionId
    readonly asker: InstanceId
    readonly title: string
    readonly items: readonly { readonly text: string; readonly options?: readonly string[]; readonly required?: boolean }[]
  }): Promise<Result<QuestionRecord>>
  answer(
    projectId: ProjectId,
    questionId: string,
    answers: readonly QuestionAnswer[],
  ): Promise<Result<QuestionRecord>>
  list(projectId: ProjectId, filter?: QuestionListFilter): Promise<Result<readonly QuestionRecord[]>>
  get(projectId: ProjectId, questionId: string): Promise<Result<QuestionRecord>>
  hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean>
  /** 等待用户答复（进程内）；回合取消由 signal 打断 */
  waitForAnswer(projectId: ProjectId, questionId: string, signal: AbortSignal): Promise<Result<QuestionRecord>>
}
