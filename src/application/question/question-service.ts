/**
 * 用户询问/确认交互（questions.jsonl，2026-09-09）：
 * Agent 在 user 会话内通过 ask_user 工具向用户提问（确认 / 单选 / 多选 / 文本），
 * 用户回答后由 API 层把答复作为用户消息写回会话并唤醒 Agent 回合（不阻塞进程）。
 * 落盘后经 EventBus 推送 `question.asked/answered`（2026-09-12）：前端按 WS 即时出卡片，不再依赖轮询。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'
import type { EventBus } from '../../infra/bus/event-bus.js'

export const QUESTION_KINDS = ['confirm', 'single', 'multi', 'text'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export interface QuestionAnswer {
  /** confirm / single */
  choice?: string
  /** multi */
  choices?: string[]
  /** 附加说明 / text 类正文 */
  text?: string
}

/** 问题列表里的一条（一次 ask_user 可以问多件事，用户在一张卡片里一次答完）。 */
export interface QuestionItem {
  id: string
  question: string
  kind: QuestionKind
  options: string[]
  allowText: boolean
  answer: QuestionAnswer | null
}

export interface QuestionRecord {
  id: string
  projectId: string
  sessionId: string
  /** 提问者（角色实例 id） */
  asker: string
  /** **问题列表**（1..N）：新版一次可问多件事 */
  items: QuestionItem[]
  /** 兼容/摘要字段：单题=题干；多题=`共 N 个问题`（列表、角标、待办标题用） */
  question: string
  kind: QuestionKind
  options: string[]
  allowText: boolean
  /**
   * pending = 正在等用户回答（一次只放行 1 条记录）
   * queued  = 同一会话里排队的后续提问（用户答完上一个自动弹出）
   */
  status: 'pending' | 'queued' | 'answered' | 'cancelled'
  /** 兼容：单题答案（多题看 items[].answer） */
  answer: QuestionAnswer | null
  createdAt: string
  answeredAt: string | null
}

/** 一次提问里的一项（工具/服务入参）。 */
export interface AskItemInput {
  question: string
  kind?: string
  options?: string[]
  allowText?: boolean
}

export interface AskInput {
  projectId: string
  sessionId: string
  asker: string
  /** 单题简写（兼容旧调用） */
  question?: string
  kind?: string
  options?: string[]
  allowText?: boolean
  /** **问题列表**：一次问多件事（1..MAX_ASK_ITEMS，推荐 2..5） */
  questions?: AskItemInput[]
  /**
   * 回合内工具调用发起（2026-09-12）：**先落盘、等回合结束再广播**。
   * 否则会出现"角色还在思考/执行，提问卡片已经弹出来"的时间错位；
   * 配合 loop 的"遇到 ask_user 即停"，卡片出现时角色正好进入「等待你处理」。
   */
  defer?: boolean
}

/** 一次 ask_user 最多问几件事（防"问卷轰炸"） */
export const MAX_ASK_ITEMS = 6

const DEFAULT_CONFIRM_OPTIONS = ['确认', '取消']

export class QuestionService {
  /** 回合内发起、等回合结束再广播的提问（内存队列；进程重启后由前端开会话时拉取兜底） */
  private deferred: Array<{ projectId: string; sessionId: string; rec: QuestionRecord }> = []

  constructor(
    private readonly projectsRoot: string,
    /** 事件总线：落盘后推送 question.asked/answered（缺省=不推，便于单测直接构造） */
    private readonly bus?: EventBus,
  ) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'questions.jsonl')
  }

  private async readAll(projectId: string): Promise<QuestionRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId), 'utf8')
    } catch {
      return []
    }
    const out: QuestionRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(normalizeRecord(JSON.parse(line) as QuestionRecord))
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  private async writeAll(projectId: string, all: QuestionRecord[]): Promise<void> {
    await fs.mkdir(join(this.projectsRoot, projectId), { recursive: true })
    await atomicWriteFile(this.file(projectId), all.map((x) => JSON.stringify(x)).join('\n') + '\n')
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
    const asked = normalizeAskItems(input)
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
      return { ...item, answer: normalizeItemAnswer(item, i, raw) }
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

/** 单项答案渲染成可读文本。 */
function pickedText(a: QuestionAnswer | null): string {
  if (!a) return '（未回答）'
  let picked = ''
  if (a.choices?.length) picked = a.choices.join('、')
  else if (a.choice) picked = a.choice
  if (a.text) picked = picked ? `${picked}（补充：${a.text}）` : a.text
  return picked || '（空）'
}

/** 单题答案校验/归一化（按 kind 校验选项合法性）。 */
function normalizeItemAnswer(item: QuestionItem, index: number, raw: QuestionAnswer): QuestionAnswer {
  const label = `第 ${index + 1} 题`
  const text = raw.text?.trim()
  const out: QuestionAnswer = {}
  if (item.kind === 'multi') {
    const choices = [...new Set((raw.choices ?? []).map((c) => String(c).trim()))].filter(Boolean)
    if (!choices.length) throw new AppError(ErrorCodes.VALIDATION, `${label}：多选至少选择 1 项`)
    const bad = choices.filter((c) => !item.options.includes(c))
    if (bad.length) {
      throw new AppError(ErrorCodes.VALIDATION, `${label}：选项不在候选中 ${bad.join('、')}`)
    }
    out.choices = choices
    if (text) out.text = text
  } else if (item.kind === 'text') {
    if (!text) throw new AppError(ErrorCodes.VALIDATION, `${label}：请输入回答内容`)
    out.text = text
  } else {
    const choice = raw.choice?.trim()
    if (!choice) throw new AppError(ErrorCodes.VALIDATION, `${label}：请选择一个选项`)
    if (!item.options.includes(choice)) {
      throw new AppError(ErrorCodes.VALIDATION, `${label}：选项不在候选中 ${choice}`)
    }
    out.choice = choice
    if (item.allowText && text) out.text = text
  }
  return out
}

/** 入参 → 规范化的问题列表（兼容"单题简写"写法）。 */
function normalizeAskItems(input: AskInput): Array<{
  question: string
  kind: QuestionKind
  options: string[]
  allowText: boolean
}> {
  const raw = input.questions?.length
    ? input.questions
    : input.question
      ? [{ question: input.question, kind: input.kind, options: input.options, allowText: input.allowText }]
      : []
  if (!raw.length) throw new AppError(ErrorCodes.VALIDATION, 'question 或 questions 必填')
  if (raw.length > MAX_ASK_ITEMS) {
    throw new AppError(
      ErrorCodes.VALIDATION,
      `一次最多问 ${MAX_ASK_ITEMS} 个问题（收到 ${raw.length} 个）；请拆分或合并`,
    )
  }
  return raw.map((item, i) => {
    const question = String(item.question ?? '').trim()
    if (!question) throw new AppError(ErrorCodes.VALIDATION, `第 ${i + 1} 个问题缺少 question`)
    const kind = (item.kind ?? 'confirm') as QuestionKind
    if (!QUESTION_KINDS.includes(kind)) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `第 ${i + 1} 个问题的 kind 必须是 ${QUESTION_KINDS.join('|')}（收到 ${String(item.kind)}）`,
      )
    }
    let options = (item.options ?? []).map((o) => String(o).trim()).filter(Boolean)
    if (kind === 'confirm') options = options.length ? options : DEFAULT_CONFIRM_OPTIONS
    if ((kind === 'single' || kind === 'multi' || kind === 'confirm') && options.length < 2) {
      throw new AppError(ErrorCodes.VALIDATION, `第 ${i + 1} 个问题：${kind} 需要至少 2 个选项`)
    }
    if (kind === 'text') options = []
    return { question, kind, options, allowText: item.allowText === true }
  })
}

/** 兼容旧数据：老记录只有单题字段 → 归一化成 1 条 items。 */
function normalizeRecord(rec: QuestionRecord): QuestionRecord {
  if (Array.isArray(rec.items) && rec.items.length) return rec
  const item: QuestionItem = {
    id: `${rec.id}_1`,
    question: rec.question ?? '',
    kind: (rec.kind ?? 'confirm') as QuestionKind,
    options: rec.options ?? [],
    allowText: rec.allowText === true,
    answer: rec.answer ?? null,
  }
  return { ...rec, items: [item] }
}

/** 问题文本归一化（去空白/标点 + 小写）：用于"同一问题不要问两次"的去重。 */
function normalizeQuestion(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}
