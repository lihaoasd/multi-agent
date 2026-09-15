import type { Clock } from '../../ports/clock'
import type { EventBroadcaster } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { Logger } from '../../ports/logger'
import type { InstanceId, ProjectId } from '../../ports/project'
import type {
  QuestionAnswer,
  QuestionListFilter,
  QuestionRecord,
  QuestionService,
  QuestionStore,
} from '../../ports/question'
import { err, ok, type Result } from '../../shared/result'

/**
 * 询问用例（tools.md §4、D19-⑦）：
 * - `ask_user` → 落 `questions.jsonl`（pending）+ 广播 `question.asked`；**同一 Agent 至多 1 个 pending**；
 * - 用户答复 → 落盘 answered + 广播 `question.answered` + 唤醒等待中的回合（进程内）；
 * - **跨重启**：pending 保持（等待者随进程消失，回合视为未完成，S8 恢复入口再处理）。
 */

export const QUESTION_LIMITS = {
  titleMaxChars: 200,
  itemsMax: 6,
  optionsMax: 8,
} as const

export interface QuestionServiceOptions {
  readonly store: QuestionStore
  readonly broadcaster: EventBroadcaster
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly logger: Logger
  /** 答复后唤醒提问者一轮（组合根提供；失败不阻断落盘） */
  readonly notify: (input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly text: string
  }) => Promise<void>
}

export function createQuestionService(options: QuestionServiceOptions): QuestionService {
  const { store, broadcaster, ids, clock, logger } = options
  const waiters = new Map<string, (record: QuestionRecord) => void>()

  const key = (projectId: string, questionId: string): string => `${projectId}:${questionId}`

  return {
    async ask(input) {
      const title = input.title.trim()
      if (title.length === 0) return err('ERR_VALIDATION', '提问标题不能为空')
      if (title.length > QUESTION_LIMITS.titleMaxChars) {
        return err('ERR_VALIDATION', `提问标题过长（≤${QUESTION_LIMITS.titleMaxChars} 字）`)
      }
      if (input.items.length === 0) return err('ERR_VALIDATION', '提问至少要有一个问题项')
      if (input.items.length > QUESTION_LIMITS.itemsMax) {
        return err('ERR_VALIDATION', `一次最多提 ${QUESTION_LIMITS.itemsMax} 个问题项`)
      }
      for (const item of input.items) {
        if (item.text.trim().length === 0) return err('ERR_VALIDATION', '问题项内容不能为空')
        if ((item.options?.length ?? 0) > QUESTION_LIMITS.optionsMax) {
          return err('ERR_VALIDATION', `单个问题项最多 ${QUESTION_LIMITS.optionsMax} 个选项`)
        }
      }

      const pending = await store.hasPending(input.projectId, input.asker)
      if (pending) {
        return err('ERR_QUESTION_PENDING', '你已有一个待答复的提问，请等待用户答复后再提问', { asker: input.asker })
      }

      const record: QuestionRecord = {
        id: ids.next('q'),
        sessionId: input.sessionId,
        asker: input.asker,
        title,
        items: input.items.map((item, index) => ({
          id: `i_${index + 1}`,
          text: item.text.trim(),
          options: item.options ?? [],
          required: item.required !== false,
        })),
        status: 'pending',
        answer: null,
        createdAt: clock.now().toISOString(),
        answeredAt: null,
      }
      const created = await store.create(input.projectId, record)
      if (!created.ok) return created
      broadcaster.broadcast({
        type: 'question.asked',
        payload: { projectId: input.projectId, question: created.value },
      })
      return created
    },

    async answer(projectId, questionId, answers: readonly QuestionAnswer[]) {
      const current = await store.get(projectId, questionId)
      if (!current.ok) return current
      const required = current.value.items.filter((item) => item.required)
      const answeredIds = new Set(answers.map((item) => item.itemId))
      const missing = required.filter((item) => !answeredIds.has(item.id))
      if (missing.length > 0) {
        return err('ERR_VALIDATION', `必答项未答复：${missing.map((item) => item.id).join('、')}`, {
          missing: missing.map((item) => item.id),
        })
      }

      const updated = await store.answer(projectId, questionId, answers)
      if (!updated.ok) return updated
      const waiter = waiters.get(key(projectId, questionId))
      if (waiter !== undefined) {
        waiters.delete(key(projectId, questionId))
        waiter(updated.value)
      }
      broadcaster.broadcast({
        type: 'question.answered',
        payload: { projectId, question: updated.value },
      })
      await options
        .notify({
          projectId,
          instanceId: updated.value.asker,
          text: `[询问] 用户已回答你的提问「${updated.value.title}」：${updated.value.answer?.answers
            .map((item) => `${item.itemId}=${item.choice ?? item.text ?? ''}`)
            .join('；') ?? ''}`,
        })
        .catch((cause: unknown) => {
          logger.warn('询问答复唤醒失败', { projectId, questionId, message: String(cause) })
        })
      return ok(updated.value)
    },

    async list(projectId: ProjectId, filter?: QuestionListFilter) {
      return store.list(projectId, filter)
    },

    async get(projectId: ProjectId, questionId: string) {
      return store.get(projectId, questionId)
    },

    async hasPending(projectId: ProjectId, instanceId: InstanceId) {
      return store.hasPending(projectId, instanceId)
    },

    async waitForAnswer(projectId, questionId, signal): Promise<Result<QuestionRecord>> {
      // 答复可能已经落盘（用户先答再进入等待）：先查一次，避免永远挂住
      const current = await store.get(projectId, questionId)
      if (current.ok && current.value.status === 'answered') return current

      return new Promise<Result<QuestionRecord>>((resolvePromise) => {
        const settle = (record: QuestionRecord): void => {
          signal.removeEventListener('abort', onAbort)
          resolvePromise(ok(record))
        }
        const onAbort = (): void => {
          waiters.delete(key(projectId, questionId))
          resolvePromise(err('ERR_CONFLICT', '回合被取消，询问等待结束', { questionId }))
        }
        waiters.set(key(projectId, questionId), settle)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}
