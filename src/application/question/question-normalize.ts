/**
 * 提问服务的**词汇与归一化规则**（P3e 从 `question-service.ts` 抽出，2026-09-14）。
 *
 * 拆出理由：`QuestionService` 原先 448 行，其中约 95 行是"入参 → 规范化"与"答案 → 可读文本"
 * 的纯函数，以及被它们共同使用的类型。这些规则不依赖 store/bus，单独放一处更易读、可单测；
 * service 只保留"落盘、排队、广播"的编排。
 *
 * **错误类型不外泄**：本模块不 import `shared/errors`，校验失败时用调用方传入的
 * `fail(message)` 抛错。`QuestionService` 传入 `(m) => new AppError(ErrorCodes.VALIDATION, m)`，
 * 因此对外**错误码与文案与重构前逐字一致**。
 * （不用模块级注入：那会让"谁先调用"决定错误类型，属于隐式全局状态。）
 *
 * 两处兼容性设计（都是**历史数据**要求，不能改）：
 *  1. `normalizeRecord`：老记录只有单题字段（question/kind/options/answer），
 *     读出来要归一化成 1 条 `items`；
 *  2. `normalizeAskItems`：入参既支持新版 `questions` 数组，也支持旧的单题简写。
 */

/** 支持的提问形式：确认 / 单选 / 多选 / 文本。 */
export const QUESTION_KINDS = ['confirm', 'single', 'multi', 'text'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/** 一次 ask_user 最多问几件事（防"问卷轰炸"） */
export const MAX_ASK_ITEMS = 6

/** confirm 类未给选项时的默认选项。 */
export const DEFAULT_CONFIRM_OPTIONS = ['确认', '取消']

/** 校验失败入口：由调用方提供（保持本模块零依赖，同时不改对外错误码）。 */
export type Fail = (message: string) => never

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

/** 单项答案渲染成可读文本。 */
export function pickedText(a: QuestionAnswer | null): string {
  if (!a) return '（未回答）'
  let picked = ''
  if (a.choices?.length) picked = a.choices.join('、')
  else if (a.choice) picked = a.choice
  if (a.text) picked = picked ? `${picked}（补充：${a.text}）` : a.text
  return picked || '（空）'
}

/** 单题答案校验/归一化（按 kind 校验选项合法性）。 */
export function normalizeItemAnswer(
  item: QuestionItem,
  index: number,
  raw: QuestionAnswer,
  fail: Fail,
): QuestionAnswer {
  const label = `第 ${index + 1} 题`
  const text = raw.text?.trim()
  const out: QuestionAnswer = {}
  if (item.kind === 'multi') {
    const choices = [...new Set((raw.choices ?? []).map((c) => String(c).trim()))].filter(Boolean)
    if (!choices.length) fail(`${label}：多选至少选择 1 项`)
    const bad = choices.filter((c) => !item.options.includes(c))
    if (bad.length) fail(`${label}：选项不在候选中 ${bad.join('、')}`)
    out.choices = choices
    if (text) out.text = text
  } else if (item.kind === 'text') {
    if (!text) fail(`${label}：请输入回答内容`)
    out.text = text
  } else {
    const choice = raw.choice?.trim()
    if (!choice) fail(`${label}：请选择一个选项`)
    if (!item.options.includes(choice)) fail(`${label}：选项不在候选中 ${choice}`)
    out.choice = choice
    if (item.allowText && text) out.text = text
  }
  return out
}

/** 入参 → 规范化的问题列表（兼容"单题简写"写法）。 */
export function normalizeAskItems(
  input: AskInput,
  fail: Fail,
): Array<{
  question: string
  kind: QuestionKind
  options: string[]
  allowText: boolean
}> {
  const raw = input.questions?.length
    ? input.questions
    : input.question
      ? [
          {
            question: input.question,
            kind: input.kind,
            options: input.options,
            allowText: input.allowText,
          },
        ]
      : []
  if (!raw.length) fail('question 或 questions 必填')
  if (raw.length > MAX_ASK_ITEMS) {
    fail(`一次最多问 ${MAX_ASK_ITEMS} 个问题（收到 ${raw.length} 个）；请拆分或合并`)
  }
  return raw.map((item, i) => {
    const question = String(item.question ?? '').trim()
    if (!question) fail(`第 ${i + 1} 个问题缺少 question`)
    const kind = (item.kind ?? 'confirm') as QuestionKind
    if (!QUESTION_KINDS.includes(kind)) {
      fail(`第 ${i + 1} 个问题的 kind 必须是 ${QUESTION_KINDS.join('|')}（收到 ${String(item.kind)}）`)
    }
    let options = (item.options ?? []).map((o) => String(o).trim()).filter(Boolean)
    if (kind === 'confirm') options = options.length ? options : DEFAULT_CONFIRM_OPTIONS
    if ((kind === 'single' || kind === 'multi' || kind === 'confirm') && options.length < 2) {
      fail(`第 ${i + 1} 个问题：${kind} 需要至少 2 个选项`)
    }
    if (kind === 'text') options = []
    return { question, kind, options, allowText: item.allowText === true }
  })
}

/** 兼容旧数据：老记录只有单题字段 → 归一化成 1 条 items。 */
export function normalizeRecord(rec: QuestionRecord): QuestionRecord {
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
export function normalizeQuestion(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}
