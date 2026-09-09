/**
 * 任务分派（甲模式，2026-09-09）：产品/项目经理在 user 会话的回复中以
 * json 代码块声明分派意图，由平台在其回复落盘前解析并执行——
 *   创建任务(todo) → start 未显式 false 且受派者槽位空闲时置 in_progress
 *   → 触发既有"激活即唤醒"(D18-③)，受派者自动开工。
 * 不命中任何分派意图时返回空说明；失败项以说明文本回给用户（不静默）。
 */
import type { TeamMemberConfig } from '../../shared/types/project.js'
import type { TaskService } from './task-service.js'

/** 一条分派意图（模型 JSON 数组元素规范化后）。 */
export interface TaskDispatchIntent {
  assignee: string
  title: string
  desc?: string
  /** 缺省 true：创建后立即开工（受派者空闲时） */
  start?: boolean
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
  state?: 'todo' | 'in_progress'
  reason?: string
}

export interface DispatchInput {
  projectId: string
  sessionId: string
  actorId: string
  actorName: string
  text: string
  team: TeamMemberConfig[]
  tasks: TaskService
  /** 审计事件回写（tool_call/tool_result 落 session log 并广播） */
  emitTool: (kind: 'tool_call' | 'tool_result', payload: Record<string, unknown>) => Promise<void>
}

/** 从模型回复提取分派指令（纯函数）。 */
export function parseTaskIntents(text: string): ParseResult {
  const errors: string[] = []
  const arrays: string[] = []
  // 1) json 代码围栏
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g
  for (;;) {
    const fm = fenceRe.exec(text)
    if (!fm) break
    arrays.push(fm[1] ?? '')
  }
  // 2) 无代码围栏时兜底：取首个 '[' 到最后一个 ']' 的片段
  const fencedCount = arrays.length
  const first = text.indexOf('[')
  const last = text.lastIndexOf(']')
  if (fencedCount === 0 && first >= 0 && last > first) arrays.push(text.slice(first, last + 1))

  const intents: TaskDispatchIntent[] = []
  for (const raw of arrays) {
    let arr: unknown
    try {
      arr = JSON.parse(raw)
    } catch {
      continue // 非 JSON（如代码示例）跳过
    }
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.assignee !== 'string' || typeof e.title !== 'string') continue // 需 task 形
      const title = e.title.trim()
      if (!title) {
        errors.push('存在空标题任务，已跳过')
        continue
      }
      intents.push({
        assignee: e.assignee.trim(),
        title,
        desc: typeof e.desc === 'string' ? e.desc : undefined,
        start: typeof e.start === 'boolean' ? e.start : true,
      })
    }
  }
  return { intents, errors }
}

/**
 * 执行分派：逐条创建任务并按需激活；返回追加到回复末尾的平台说明（无意图返回空串）。
 * 单条失败不中断其余项。
 */
export async function dispatchTasksFromText(input: DispatchInput): Promise<string> {
  const { intents } = parseTaskIntents(input.text)
  if (!intents.length) return ''

  const enabled = new Map(
    input.team.filter((m) => m.enabled).map((m) => [m.instanceId, m] as const),
  )
  const results: DispatchItemResult[] = []

  for (const intent of intents) {
    const target = enabled.get(intent.assignee)
    if (!target) {
      results.push({
        assignee: intent.assignee,
        title: intent.title,
        ok: false,
        reason: `实例 ${intent.assignee} 不存在或已停用（可指派：${[...enabled.keys()].join('、') || '无'}）`,
      })
      continue
    }
    if (target.instanceId === input.actorId) {
      results.push({
        assignee: intent.assignee,
        title: intent.title,
        ok: false,
        reason: '不能派发给自己',
      })
      continue
    }

    await input.emitTool('tool_call', {
      tool: 'task_assign',
      actor: input.actorId,
      input: {
        assignee: intent.assignee,
        title: intent.title.slice(0, 200),
        desc: (intent.desc ?? '').slice(0, 300),
        start: intent.start,
      },
    })

    try {
      const rec = await input.tasks.create({
        projectId: input.projectId,
        title: intent.title,
        desc: intent.desc,
        creator: input.actorId,
        assignee: intent.assignee,
        sessionId: `u_${intent.assignee}`,
      })
      let state: 'todo' | 'in_progress' = 'todo'
      let reason: string | undefined
      if (intent.start !== false) {
        try {
          await input.tasks.setState(input.projectId, rec.id, 'in_progress', input.actorId)
          state = 'in_progress'
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e)
        }
      }
      results.push({ taskId: rec.id, assignee: intent.assignee, title: intent.title, ok: true, state, reason })
      await input.emitTool('tool_result', {
        tool: 'task_assign',
        taskId: rec.id,
        assignee: intent.assignee,
        state,
        reason: reason?.slice(0, 300),
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      results.push({ assignee: intent.assignee, title: intent.title, ok: false, reason })
      await input.emitTool('tool_result', {
        tool: 'task_assign',
        assignee: intent.assignee,
        ok: false,
        reason: reason.slice(0, 300),
      })
    }
  }

  const lines = results.map((r) => {
    if (!r.ok) return `- ⚠️ 未创建「${r.title}」→ ${r.assignee}：${r.reason ?? '未知原因'}`
    if (r.state === 'in_progress')
      return `- ✅ 任务 ${r.taskId}「${r.title}」→ ${r.assignee}（已开始执行）`
    return `- ⏳ 任务 ${r.taskId}「${r.title}」→ ${r.assignee}（已排队 todo：${r.reason ?? '等待开工'}，可在任务面板点开工）`
  })
  return `\n\n【系统 · 任务分派】\n${lines.join('\n')}`
}
