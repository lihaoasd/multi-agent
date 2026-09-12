/**
 * 任务分派（甲模式，2026-09-09；2026-09-12 改为"发布到任务栏 → 通知领取"）：
 * 产品/项目经理把任务发布给团队成员，任务落 `todo`（任务栏·待领取）并通知受派人领取，
 * 受派人用 `task_claim` 领取后才开工（不再由平台直接置 in_progress）。
 *
 * 两条入口，共用同一套校验与落库逻辑：
 *  1) **`task_assign` 工具**（推荐，function-calling）——模型直接调用，参数结构化，无解析风险；
 *  2) **回复里的 JSON 数组**（兼容文本协议）——历史模型习惯；解析容错（围栏内多余引号/说明、无围栏、
 *     多个数组、重复项去重），并且**解析失败时必然回执**（绝不再静默失败）。
 */
import type { TeamMemberConfig } from '../../shared/types/project.js'
import type { TaskService } from './task-service.js'

/** 一条分派意图（模型 JSON 数组元素规范化后）。 */
export interface TaskDispatchIntent {
  assignee: string
  title: string
  desc?: string
  /** 逃生阀：确需重复发布时跳过同题去重 */
  force?: boolean
}

export interface ParseResult {
  intents: TaskDispatchIntent[]
  errors: string[]
}

/** 逐项结果（供说明文本与审计）。 */
export interface DispatchItemResult {
  taskId?: string
  assignee: string
  title: string
  ok: boolean
  state?: 'todo' | 'in_progress' | 'done' | 'blocked' | 'terminated'
  /** 命中同题去重（未新建，taskId=既有任务） */
  duplicate?: boolean
  existingCreator?: string
  reason?: string
}
/** 单条派发的依赖（工具入口与文本入口共用）。 */
export interface TaskAssignDeps {
  projectId: string
  actorId: string
  team: TeamMemberConfig[]
  tasks: TaskService
  /** 审计事件回写（文本入口用；工具入口由工具循环自己记事件，可传 noop） */
  emitTool: (kind: 'tool_call' | 'tool_result', payload: Record<string, unknown>) => Promise<void>
}

export interface DispatchInput extends Omit<TaskAssignDeps, 'team'> {
  sessionId: string
  actorName: string
  text: string
  team: TeamMemberConfig[]
}

/** 花括号/方括号配对切片（内部字符串与转义安全）；不平衡返回 null。 */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 从任意文本中提取所有能解析的 JSON 数组（围栏、正文、多个数组均可）。 */
function extractJsonArrays(text: string): unknown[][] {
  const out: unknown[][] = []
  let i = 0
  for (;;) {
    const start = text.indexOf('[', i)
    if (start < 0) break
    const slice = balancedSlice(text, start)
    if (!slice) {
      i = start + 1
      continue
    }
    try {
      const parsed: unknown = JSON.parse(slice)
      if (Array.isArray(parsed)) out.push(parsed)
    } catch {
      // 非 JSON（如 markdown 链接 [文本](url)）→ 继续找下一个
    }
    i = start + slice.length
  }
  return out
}

/**
 * 从模型回复提取分派指令（纯函数，容错）：
 * 逐个提取文本中的 JSON 数组并取"task 形"元素（含 assignee + title），按 assignee+title 去重。
 */
export function parseTaskIntents(text: string): ParseResult {
  const errors: string[] = []
  const intents: TaskDispatchIntent[] = []
  const seen = new Set<string>()
  for (const arr of extractJsonArrays(text)) {
    for (const entry of arr) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.assignee !== 'string' || typeof e.title !== 'string') continue // 需 task 形
      const title = e.title.trim()
      if (!title) {
        errors.push('存在空标题任务，已跳过')
        continue
      }
      const assignee = e.assignee.trim()
      const key = `${assignee}\u0000${title}`
      if (seen.has(key)) continue // 围栏 + 全文扫描会重复命中，去重
      seen.add(key)
      intents.push({
        assignee,
        title,
        desc: typeof e.desc === 'string' ? e.desc : undefined,
        force: e.force === true,
      })
    }
  }
  return { intents, errors }
}

/** 文本是否"看起来想派单"（用于解析失败时给出明确回执，而不是静默）。 */
export function looksLikeDispatchAttempt(text: string): boolean {
  return /"assignee"|'assignee'|assignee\s*[:：]/.test(text)
}

/**
 * 发布单条任务到任务栏：校验受派人 → 创建(todo) + 通知领取（create() 内部完成）。
 * 返回逐项结果（失败也返回，由调用方汇总）。
 */
export async function assignTaskFromIntent(
  deps: TaskAssignDeps,
  intent: TaskDispatchIntent,
): Promise<DispatchItemResult> {
  const enabled = new Map(deps.team.filter((m) => m.enabled).map((m) => [m.instanceId, m] as const))
  const target = enabled.get(intent.assignee)
  if (!target) {
    return {
      assignee: intent.assignee,
      title: intent.title,
      ok: false,
      reason: `实例 ${intent.assignee} 不存在或已停用（可指派：${[...enabled.keys()].join('、') || '无'}）`,
    }
  }
  if (target.instanceId === deps.actorId) {
    return { assignee: intent.assignee, title: intent.title, ok: false, reason: '不能派发给自己' }
  }

  await deps.emitTool('tool_call', {
    tool: 'task_assign',
    actor: deps.actorId,
    input: {
      assignee: intent.assignee,
      title: intent.title.slice(0, 200),
      desc: (intent.desc ?? '').slice(0, 300),
      force: intent.force === true,
    },
  })

  try {
    const { task: rec, duplicate } = await deps.tasks.create(
      {
        projectId: deps.projectId,
        title: intent.title,
        desc: intent.desc,
        creator: deps.actorId,
        assignee: intent.assignee,
        sessionId: `u_${intent.assignee}`,
      },
      { force: intent.force === true },
    )
    await deps.emitTool('tool_result', {
      tool: 'task_assign',
      taskId: rec.id,
      assignee: intent.assignee,
      state: rec.state,
      duplicate,
    })
    return {
      taskId: rec.id,
      assignee: intent.assignee,
      title: intent.title,
      ok: true,
      state: rec.state,
      duplicate,
      existingCreator: duplicate ? rec.creator : undefined,
      reason: duplicate ? `已存在同题任务（由 ${rec.creator} 发布）` : '已发布待领取',
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    await deps.emitTool('tool_result', {
      tool: 'task_assign',
      assignee: intent.assignee,
      ok: false,
      reason: reason.slice(0, 300),
    })
    return { assignee: intent.assignee, title: intent.title, ok: false, reason }
  }
}

/** 逐项结果 → 面向用户的说明行。 */
export function dispatchNoteFromResults(results: DispatchItemResult[]): string {
  const lines = results.map((r) => {
    if (!r.ok) return `- ⚠️ 未发布「${r.title}」→ ${r.assignee}：${r.reason ?? '未知原因'}`
    if (r.duplicate)
      return (
        `- ♻️ 「${r.title}」→ ${r.assignee}：已存在同题任务 ${r.taskId}` +
        `（由 ${r.existingCreator ?? '他人'} 发布，状态 ${r.state ?? 'todo'}），**本次未重复创建**`
      )
    return `- 📤 任务 ${r.taskId}「${r.title}」已发布到任务栏 → ${r.assignee}（待领取，已通知对方）`
  })
  return `\n\n【系统 · 任务栏】\n${lines.join('\n')}`
}

/**
 * 文本协议入口：解析回复中的分派指令并执行；返回追加到回复末尾的平台说明。
 * 无意图且不像派单 → ''；像派单但解析失败 → 明确回执（不静默）。
 */
export async function dispatchTasksFromText(input: DispatchInput): Promise<string> {
  const parsed = parseTaskIntents(input.text)
  if (!parsed.intents.length) {
    if (!looksLikeDispatchAttempt(input.text)) return ''
    const reason = parsed.errors.length
      ? parsed.errors.join('；')
      : '未识别到有效的 JSON 数组（元素需含 assignee/title）'
    await input.emitTool('tool_result', {
      tool: 'task_assign',
      ok: false,
      code: 'ERR_VALIDATION',
      reason,
    })
    return (
      '\n\n【系统 · 任务分派】⚠️ 未识别到有效的分派指令，本次**未创建任何任务**。' +
      `原因：${reason}。\n请改用 task_assign 工具派单（推荐），或输出合法 JSON 数组，例如：` +
      '[{"assignee":"dev_1","title":"实现登录接口","start":true}]'
    )
  }

  const results: DispatchItemResult[] = []
  for (const intent of parsed.intents) {
    results.push(await assignTaskFromIntent({ ...input, team: input.team }, intent))
  }
  return dispatchNoteFromResults(results)
}
