import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { InstanceId, ProjectId } from '../../ports/project'
import type {
  QuestionAnswer,
  QuestionItem,
  QuestionListFilter,
  QuestionRecord,
  QuestionStore,
} from '../../ports/question'
import { err, ok } from '../../shared/result'

export interface QuestionStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

function parseItem(raw: unknown): QuestionItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const text = typeof record['text'] === 'string' ? record['text'] : ''
  if (id.length === 0 || text.length === 0) return null
  return {
    id,
    text,
    options: Array.isArray(record['options'])
      ? record['options'].filter((item): item is string => typeof item === 'string')
      : [],
    required: record['required'] !== false,
  }
}

function parseQuestion(raw: unknown): QuestionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id.length === 0) return null
  const items = Array.isArray(record['items'])
    ? record['items'].map(parseItem).filter((item): item is QuestionItem => item !== null)
    : []
  const answerRaw = record['answer']
  let answer: QuestionRecord['answer'] = null
  if (typeof answerRaw === 'object' && answerRaw !== null) {
    const wrapper = answerRaw as Record<string, unknown>
    const answers = Array.isArray(wrapper['answers'])
      ? wrapper['answers']
          .map((item): QuestionAnswer | null => {
            if (typeof item !== 'object' || item === null) return null
            const entry = item as Record<string, unknown>
            const itemId = typeof entry['itemId'] === 'string' ? entry['itemId'] : ''
            if (itemId.length === 0) return null
            return {
              itemId,
              choice: typeof entry['choice'] === 'string' ? entry['choice'] : null,
              text: typeof entry['text'] === 'string' ? entry['text'] : null,
            }
          })
          .filter((item): item is QuestionAnswer => item !== null)
      : []
    answer = { answers, decidedAt: typeof wrapper['decidedAt'] === 'string' ? wrapper['decidedAt'] : '' }
  }
  return {
    id,
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    asker: typeof record['asker'] === 'string' ? record['asker'] : '',
    title: typeof record['title'] === 'string' ? record['title'] : '',
    items,
    status: record['status'] === 'answered' ? 'answered' : 'pending',
    answer,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    answeredAt: typeof record['answeredAt'] === 'string' ? record['answeredAt'] : null,
  }
}

/** 询问存储（data-storage.md §7）：`questions.jsonl` append-only，同 id 取最后一条；pending 跨重启保持 */
export function createQuestionStore(options: QuestionStoreOptions): QuestionStore {
  const { fileStore, lock } = options
  const pathFor = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/questions.jsonl`

  const readAll = async (projectId: ProjectId): Promise<readonly QuestionRecord[]> => {
    const text = await fileStore.readText(pathFor(projectId))
    if (!text.ok) return []
    const merged = new Map<string, QuestionRecord>()
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseQuestion(JSON.parse(trimmed))
        if (parsed !== null) merged.set(parsed.id, parsed)
      } catch {
        // 坏行跳过
      }
    }
    return [...merged.values()]
  }

  return {
    async create(projectId, record) {
      return lock.withLock(`questions:${projectId}`, async () => {
        const pending = (await readAll(projectId)).some(
          (item) => item.status === 'pending' && item.asker === record.asker,
        )
        if (pending) {
          return err('ERR_QUESTION_PENDING', `该角色已有待答复的提问，不能重复提问`, { asker: record.asker })
        }
        const appended = await fileStore.appendLine(pathFor(projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async answer(projectId, questionId, answers) {
      return lock.withLock(`questions:${projectId}`, async () => {
        const current = (await readAll(projectId)).find((item) => item.id === questionId)
        if (current === undefined) {
          return err('ERR_NOT_FOUND', `提问不存在：${questionId}`, { questionId })
        }
        if (current.status === 'answered') {
          return err('ERR_CONFLICT', '该提问已答复', { questionId })
        }
        const nowIso = options.clock.now().toISOString()
        const updated: QuestionRecord = {
          ...current,
          status: 'answered',
          answer: { answers, decidedAt: nowIso },
          answeredAt: nowIso,
        }
        const appended = await fileStore.appendLine(pathFor(projectId), JSON.stringify(updated))
        return appended.ok ? ok(updated) : appended
      })
    },

    async list(projectId, filter?: QuestionListFilter) {
      let questions = [...(await readAll(projectId))]
      if (filter?.status !== undefined) questions = questions.filter((item) => item.status === filter.status)
      if (filter?.sessionId !== undefined) questions = questions.filter((item) => item.sessionId === filter.sessionId)
      questions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return ok(filter?.limit === undefined ? questions : questions.slice(0, filter.limit))
    },

    async get(projectId, questionId) {
      const found = (await readAll(projectId)).find((item) => item.id === questionId)
      return found === undefined ? err('ERR_NOT_FOUND', `提问不存在：${questionId}`, { questionId }) : ok(found)
    },

    async hasPending(projectId: ProjectId, instanceId: InstanceId): Promise<boolean> {
      return (await readAll(projectId)).some((item) => item.status === 'pending' && item.asker === instanceId)
    },
  }
}
