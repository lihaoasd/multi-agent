/**
 * 用户询问/确认交互（questions.jsonl，2026-09-09）：
 * Agent 在 user 会话内通过 ask_user 工具向用户提问（确认 / 单选 / 多选 / 文本），
 * 用户回答后由 API 层把答复作为用户消息写回会话并唤醒 Agent 回合（不阻塞进程）。
 * 落盘后经 EventBus 推送 `question.asked/answered`（2026-09-12）：前端按 WS 即时出卡片，不再依赖轮询。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../shared/util/id.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import type { ProjectStore } from '../../infra/store/project-store.js'
import {
  normalizeAskItems,
  normalizeItemAnswer,
  normalizeQuestion,
  normalizeRecord,
  pickedText,
  type AskInput,
  type QuestionAnswer,
  type QuestionItem,
  type QuestionRecord,
} from './question-normalize.js'

/**
 * 词汇与归一化规则已归位 `./question-normalize.ts`（P3e）；此处 re-export 保持既有调用方不变
 * （`composition` 转出 `QuestionRecord` 给 REST 层，工具层只用服务实例类型）。
 */
export {
  MAX_ASK_ITEMS,
  QUESTION_KINDS,
  type AskInput,
  type QuestionAnswer,
  type QuestionItem,
  type QuestionKind,
  type QuestionRecord,
} from './question-normalize.js'

/** 提问记录文件的项目相对路径。 */
const FILE = 'questions.jsonl'

/**
 * 校验失败入口：保持对外仍是 `AppError(ERR_VALIDATION, message)`。
 * 归一化模块不依赖 `shared/errors`，所以把"怎么抛错"作为参数传进去。
 */
const fail = (message: string): never => {
  throw new AppError(ErrorCodes.VALIDATION, message)
}

export class QuestionService {
  /** 回合内发起、等回合结束再广播的提问（内存队列；进程重启后由前端开会话时拉取兜底） */
  private deferred: Array<{ projectId: string; sessionId: string; rec: QuestionRecord }> = []

  constructor(
    private readonly store: ProjectStore,
    /** 事件总线：落盘后推送 question.asked/answered（缺省=不推，便于单测直接构造） */
    private readonly bus?: EventBus,
  ) {}

  private async readAll(projectId: string): Promise<QuestionRecord[]> {
    const raw = await this.store.readAll<QuestionRecord>(projectId, FILE)
    // 存储层的坏行容错已保证只拿到合法 JSON；这里再统一做记录归一化
    return raw.map((r) => normalizeRecord(r))
  }

  private async writeAll(projectId: string, all: QuestionRecord[]): Promise<void> {
    await this.store.mutate<QuestionRecord>(projectId, FILE, () => all)
  }

  async list(
    projectId: string,
    filter: { status?: string; sessionId?: string } = {},
  ): Promise<QuestionRecord[]> {
    let all = await this.readAll(projectId)
    if (filter.status) all = all.filter((q) => q.status === filter.status)
    if (filter.sessionId) all = all.filter((q) => q.sessionId === filter.sessionId)
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async get(projectId: string, id: string): Promise<QuestionRecord> {
    const rec = (await this.readAll(projectId)).find((q) => q.id === id)
    if (!rec) throw new AppError(ErrorCodes.NOT_FOUND, `提问不存在: ${id}`)
    return rec
  }

  /**
   * 该会话当前待回答的提问（无则 null）。
   * 供 ask_user 工具做**软挂起**：已有待答提问时不再新建、不再报错，直接结束本回合等用户回答，
   * 避免"一次问多个 → 第二/第三个报错"这种看起来像失败的噪声（2026-09-12）。
   */
  async pendingOf(projectId: string, sessionId: string): Promise<QuestionRecord | null> {
    const all = await this.readAll(projectId)
    return all.find((q) => q.sessionId === sessionId && q.status === 'pending') ?? null
  }

  /**
   * 发起提问（**问题列表**：一次可以问 1..N 件事，用户在一张卡片里一次答完）。
   * - 同一会话**同时只放行 1 条 pending**（防刷屏）：已有 pending 时整条进 `queued` 队列，
   *   用户答完上一个后自动把队首提升为 pending；
   * - **同一批问题不重复建**：各题文本归一化后拼起来相同 → 直接返回既有记录。
   */
  async ask(input: AskInput): Promise<{ record: QuestionRecord; duplicate: boolean }> {
    const asked = normalizeAskItems(input, fail)
    const all = await this.readAll(input.projectId)
    const signature = asked.map((a) => normalizeQuestion(a.question)).join('\u0000')
    // 同一批问题（归一化后相同）不重复问，也不重复排队
    const dup = all.find(
      (q) =>
        q.sessionId === input.sessionId &&
        (q.status === 'pending' || q.status === 'queued') &&
        q.items.map((i) => normalizeQuestion(i.question)).join('\u0000') === signature,
    )
    if (dup) return { record: dup, duplicate: true }

    const hasPending = all.some((q) => q.sessionId === input.sessionId && q.status === 'pending')
    const recId = genId('q_')
    const items: QuestionItem[] = asked.map((a, i) => ({
      id: `${recId}_${i + 1}`,
      question: a.question,
      kind: a.kind,
      options: a.options,
      allowText: a.allowText,
      answer: null,
    }))
    const first = items[0]!
    const rec: QuestionRecord = {
      id: recId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      asker: input.asker,
      items,
      // 兼容/摘要字段
      question: items.length === 1 ? first.question : `共 ${items.length} 个问题`,
      kind: items.length === 1 ? first.kind : 'single',
      options: items.length === 1 ? first.options : [],
      allowText: items.length === 1 ? first.allowText : false,
      // 已有待答 → 排队；否则立即待答
      status: hasPending ? 'queued' : 'pending',
      answer: null,
      createdAt: nowIso(),
      answeredAt: null,
    }
    all.push(rec)
    await this.writeAll(input.projectId, all)
    // 先盘后推：默认立即广播；回合内发起（defer）则等回合结束由 flushPending 统一广播，
    // 避免"角色还在思考/执行 → 提问卡片已经弹出"的时间错位。
    if (rec.status !== 'pending') {
      // 排队中的问题等被提升为 pending 时再推送
    } else if (input.defer) {
      this.deferred.push({ projectId: rec.projectId, sessionId: rec.sessionId, rec })
    } else {
      this.emitAsked(rec)
    }
    return { record: rec, duplicate: false }
  }

  /**
   * 广播本回合积压的提问（由 loop 在**回合结束、占用释放之后**调用）：
   * 此时角色的消息已落盘、状态已转「等待你处理」，卡片出现的时间点与状态一致。
   */
  flushPending(projectId: string, sessionId?: string): void {
    const keep: typeof this.deferred = []
    for (const item of this.deferred) {
      if (item.projectId !== projectId || (sessionId && item.sessionId !== sessionId)) {
        keep.push(item)
        continue
      }
      this.emitAsked(item.rec)
    }
    this.deferred = keep
  }

  private emitAsked(rec: QuestionRecord): void {
    this.bus?.emit('question.asked', rec.projectId, rec.sessionId, {
      questionId: rec.id,
      asker: rec.asker,
      kind: rec.kind,
      question: rec.question,
      options: rec.options,
      record: rec,
    })
  }

  /**
   * 用户回答：校验后落盘（answered 不可重复回答）。
   * - `answers` = 逐题作答（问题列表时**必须每题都答**，itemId 缺省按顺序对齐）；
   * - 兼容旧调用：直接传 `{choice/choices/text}`（仅当只有 1 题时可用）。
   * 回答后**自动推进队列**：把该会话最早的 `queued` 提升为 `pending` 并推送（下一张卡片立即出现）；
   * 返回值 `next` 非空表示"还有问题要问"，调用方据此**暂不唤醒角色**（等队列清空再唤醒）。
   */
  async answer(
    projectId: string,
    id: string,
    answer: QuestionAnswer & { answers?: Array<QuestionAnswer & { itemId?: string }> },
  ): Promise<{ question: QuestionRecord; next: QuestionRecord | null }> {
    const all = await this.readAll(projectId)
    const idx = all.findIndex((q) => q.id === id)
    if (idx < 0) throw new AppError(ErrorCodes.NOT_FOUND, `提问不存在: ${id}`)
    const cur = all[idx]!
    if (cur.status !== 'pending') {
      throw new AppError(ErrorCodes.CONFLICT, `该提问已处理（${cur.status}）: ${id}`)
    }

    const perItem = answer.answers
    if (perItem?.length && cur.items.length === 1 && perItem.length === 1) {
      // 单题时允许 {answers:[{choice}]} 这种写法
    }
    const items: QuestionItem[] = cur.items.map((item, i) => {
      const raw: QuestionAnswer | undefined = perItem?.length
        ? (perItem.find((a) => a.itemId === item.id) ?? perItem[i])
        : i === 0
          ? answer
          : undefined
      if (!raw) {
        throw new AppError(
          ErrorCodes.VALIDATION,
          `第 ${i + 1} 题还没回答：「${item.question.slice(0, 40)}」（问题列表需要每题都作答）`,
        )
      }
      return { ...item, answer: normalizeItemAnswer(item, i, raw, fail) }
    })

    const next: QuestionRecord = {
      ...cur,
      items,
      // 兼容字段：单题时同步答案；多题时 answer 为 null（逐题看 items[].answer）
      answer: items.length === 1 ? items[0]!.answer : null,
      status: 'answered',
      answeredAt: nowIso(),
    }
    all[idx] = next
    // 队列推进：同一会话里最早的 queued 提升为 pending（先盘后推）
    const qIdx = all.findIndex((q) => q.sessionId === next.sessionId && q.status === 'queued')
    let promoted: QuestionRecord | null = null
    if (qIdx >= 0) {
      promoted = { ...all[qIdx]!, status: 'pending' }
      all[qIdx] = promoted
    }
    await this.writeAll(projectId, all)
    // 先盘后推：多标签页/其它窗口同步移除待答卡片
    this.bus?.emit('question.answered', next.projectId, next.sessionId, {
      questionId: next.id,
      asker: next.asker,
      answer: next.answer,
      answers: items.map((i) => ({ itemId: i.id, answer: i.answer })),
      nextQuestionId: promoted?.id ?? null,
    })
    // 下一张卡片立即出现（同一时刻角色的状态仍是「等待你处理」）
    if (promoted) this.emitAsked(promoted)
    return { question: next, next: promoted }
  }

  /** 该会话还在排队的问题数（唤醒判断用）。 */
  async queuedCount(projectId: string, sessionId: string): Promise<number> {
    const all = await this.readAll(projectId)
    return all.filter((q) => q.sessionId === sessionId && q.status === 'queued').length
  }

  /**
   * **作废**该会话里所有未处理的提问（pending/queued → cancelled，2026-09-12）。
   *
   * 用途：角色被拉进会议（`meeting_start`）时，它手头"等待你处理"的提问要先放下——
   * 否则会出现"卡片还在等用户，角色却已入会"的状态叠加。作废后推 `question.answered`
   * （前端据此撤下卡片，复用既有事件，无需新协议），并写明原因。
   *
   * @returns 被作废的提问（供开会前记录"搁置事项"，散会后回注给角色）
   */
  async cancelPending(
    projectId: string,
    sessionId: string,
    reason: string,
  ): Promise<Array<{ id: string; question: string }>> {
    const all = await this.readAll(projectId)
    const hit = all.filter(
      (q) => q.sessionId === sessionId && (q.status === 'pending' || q.status === 'queued'),
    )
    if (!hit.length) return []
    const cancelled = new Set(hit.map((q) => q.id))
    const next = all.map((q) =>
      cancelled.has(q.id) ? { ...q, status: 'cancelled' as const, answeredAt: nowIso() } : q,
    )
    await this.writeAll(projectId, next)
    // 先盘后推：逐条推 answered（带作废原因），前端撤卡片、待办条随之消失
    for (const q of hit) {
      this.bus?.emit('question.answered', q.projectId, q.sessionId, {
        questionId: q.id,
        asker: q.asker,
        answer: null,
        cancelled: true,
        reason,
      })
    }
    return hit.map((q) => ({ id: q.id, question: q.question }))
  }

  /** 答复的可读文本（写回会话的用户消息）：问题列表逐条列出。 */
  static answerText(rec: QuestionRecord): string {
    const lines = rec.items.map((it, i) => {
      const prefix = rec.items.length > 1 ? `${i + 1}) ` : ''
      return `${prefix}${it.question}\n→ ${pickedText(it.answer)}`
    })
    const head =
      rec.items.length > 1
        ? `【回答提问 ${rec.id}】共 ${rec.items.length} 个问题`
        : `【回答提问 ${rec.id}】${rec.items[0]?.question ?? rec.question}`
    return `${head}\n${lines.join('\n')}`
  }
}

