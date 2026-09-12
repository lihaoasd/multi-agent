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

export interface QuestionRecord {
  id: string
  projectId: string
  sessionId: string
  /** 提问者（角色实例 id） */
  asker: string
  question: string
  kind: QuestionKind
  options: string[]
  allowText: boolean
  status: 'pending' | 'answered' | 'cancelled'
  answer: QuestionAnswer | null
  createdAt: string
  answeredAt: string | null
}

export interface AskInput {
  projectId: string
  sessionId: string
  asker: string
  question: string
  kind?: string
  options?: string[]
  allowText?: boolean
  /**
   * 回合内工具调用发起（2026-09-12）：**先落盘、等回合结束再广播**。
   * 否则会出现"角色还在思考/执行，提问卡片已经弹出来"的时间错位；
   * 配合 loop 的"遇到 ask_user 即停"，卡片出现时角色正好进入「等待你处理」。
   */
  defer?: boolean
}

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
        out.push(JSON.parse(line) as QuestionRecord)
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

  /** 发起提问：同一会话同时只允许 1 个待回答（防刷屏）。 */
  async ask(input: AskInput): Promise<QuestionRecord> {
    const question = input.question?.trim()
    if (!question) throw new AppError(ErrorCodes.VALIDATION, 'question 必填')
    const kind = (input.kind ?? 'confirm') as QuestionKind
    if (!QUESTION_KINDS.includes(kind)) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `kind 必须是 ${QUESTION_KINDS.join('|')}（收到 ${String(input.kind)}）`,
      )
    }
    let options = (input.options ?? []).map((o) => String(o).trim()).filter(Boolean)
    if (kind === 'confirm') options = options.length ? options : DEFAULT_CONFIRM_OPTIONS
    if ((kind === 'single' || kind === 'multi' || kind === 'confirm') && options.length < 2) {
      throw new AppError(ErrorCodes.VALIDATION, `${kind} 需要至少 2 个选项`)
    }
    if (kind === 'text') options = []

    const pending = (await this.readAll(input.projectId)).find(
      (q) => q.sessionId === input.sessionId && q.status === 'pending',
    )
    if (pending) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `已有待回答的问题 ${pending.id}：「${pending.question.slice(0, 40)}」，请等待用户回答后再提问`,
      )
    }

    const rec: QuestionRecord = {
      id: genId('q_'),
      projectId: input.projectId,
      sessionId: input.sessionId,
      asker: input.asker,
      question,
      kind,
      options,
      allowText: input.allowText === true,
      status: 'pending',
      answer: null,
      createdAt: nowIso(),
      answeredAt: null,
    }
    const all = await this.readAll(input.projectId)
    all.push(rec)
    await this.writeAll(input.projectId, all)
    // 先盘后推：默认立即广播；回合内发起（defer）则等回合结束由 flushPending 统一广播，
    // 避免"角色还在思考/执行 → 提问卡片已经弹出"的时间错位。
    if (input.defer) {
      this.deferred.push({ projectId: rec.projectId, sessionId: rec.sessionId, rec })
    } else {
      this.emitAsked(rec)
    }
    return rec
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

  /** 用户回答：校验后落盘（answered 不可重复回答）。 */
  async answer(projectId: string, id: string, answer: QuestionAnswer): Promise<QuestionRecord> {
    const all = await this.readAll(projectId)
    const idx = all.findIndex((q) => q.id === id)
    if (idx < 0) throw new AppError(ErrorCodes.NOT_FOUND, `提问不存在: ${id}`)
    const cur = all[idx]!
    if (cur.status !== 'pending') {
      throw new AppError(ErrorCodes.CONFLICT, `该提问已处理（${cur.status}）: ${id}`)
    }

    const text = answer.text?.trim()
    const normalized: QuestionAnswer = {}
    if (cur.kind === 'multi') {
      const choices = [...new Set((answer.choices ?? []).map((c) => String(c).trim()))].filter(
        Boolean,
      )
      if (!choices.length) throw new AppError(ErrorCodes.VALIDATION, '多选至少选择 1 项')
      const bad = choices.filter((c) => !cur.options.includes(c))
      if (bad.length) {
        throw new AppError(ErrorCodes.VALIDATION, `选项不在候选中: ${bad.join('、')}`)
      }
      normalized.choices = choices
      if (text) normalized.text = text
    } else if (cur.kind === 'text') {
      if (!text) throw new AppError(ErrorCodes.VALIDATION, '请输入回答内容')
      normalized.text = text
    } else {
      const choice = answer.choice?.trim()
      if (!choice) throw new AppError(ErrorCodes.VALIDATION, '请选择一个选项')
      if (!cur.options.includes(choice)) {
        throw new AppError(ErrorCodes.VALIDATION, `选项不在候选中: ${choice}`)
      }
      normalized.choice = choice
      if (cur.allowText && text) normalized.text = text
    }

    const next: QuestionRecord = {
      ...cur,
      status: 'answered',
      answer: normalized,
      answeredAt: nowIso(),
    }
    all[idx] = next
    await this.writeAll(projectId, all)
    // 先盘后推：多标签页/其它窗口同步移除待答卡片
    this.bus?.emit('question.answered', next.projectId, next.sessionId, {
      questionId: next.id,
      asker: next.asker,
      answer: normalized,
    })
    return next
  }

  /** 答复的可读文本（写回会话的用户消息）。 */
  static answerText(rec: QuestionRecord): string {
    const a = rec.answer ?? {}
    let picked = ''
    if (a.choices?.length) picked = a.choices.join('、')
    else if (a.choice) picked = a.choice
    if (a.text) picked = picked ? `${picked}（补充：${a.text}）` : a.text
    return `【回答提问 ${rec.id}】${rec.question}\n→ ${picked || '（空）'}`
  }
}
