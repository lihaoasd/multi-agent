/**
 * 回合执行的常量与纯工具（P3g 从 `loop-runner.ts` 抽出，2026-09-14）。
 *
 * 抽出的都是**不依赖 runner 实例**的东西：上限常量、收尾提示词、工具名集合、
 * "挂起回合"的占位事件，以及 JSON/截断/摘要三个纯工具。
 * runner 只保留"回合是怎么走的"编排，读起来更聚焦。
 */
import type { SessionLogEvent } from '../../shared/types/session.js'

/** 思考/推理文本落盘上限（超长截断，防 log 膨胀） */
export const MAX_REASONING_CHARS = 20000
/** 工具结果回注模型的上限 */
export const MAX_TOOL_RESULT_CHARS = 8000
/** 收尾回合只暴露的收尾三件套工具（不再开新工作）。 */
export const CLOSURE_TOOLS = new Set(['task_update', 'task_claim', 'artifact_submit', 'ask_user'])
/** 收尾回合的提示（步数用尽/模型空手停下/检测到空转时注入，确保任务状态与用户总结不会丢） */
export const WRAPUP_PROMPT =
  '【平台】现在进入**收尾**：不要开始新工作。请立刻完成两件事：' +
  '① 若你有进行中的任务且本轮已完成，调用 task_update（taskId 可省略，state=done，note=一句话完成总结）；' +
  '② 用一段话给出**面向用户的完成总结**：做了什么、产出文件（工作目录相对路径）、验证结果、遗留问题与建议。'
/** 无进展保护：同一工具+入参+结果连续重复这么多次 → 判定空转并收尾（无限轮时的安全阀） */
export const REPEAT_STALL_LIMIT = 3

/**
 * 角色在「等待你处理」期间被唤醒时返回的占位事件：本回合**没有开工**（不占 occupancy、不调模型），
 * 唤醒消息已落盘，等用户答复后由下一回合带着它继续。回执调用方不使用该返回值。
 */
export const SKIPPED_TURN: SessionLogEvent = {
  seq: 0,
  ts: new Date(0).toISOString(),
  sessionId: '',
  kind: 'turn_end',
  payload: { skipped: 'waiting_user' },
}

/** 解析工具参数 JSON；非法返回 null（调用方回注错误）。 */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 截断文本（可选自定义后缀）。 */
export function cut(text: string, max: number, suffix = '…(已截断)'): string {
  return text.length > max ? text.slice(0, max) + suffix : text
}

/** 审计用参数摘要：长字符串截断，避免把整份文件写进事件。 */
export function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length}字)` : value
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(summarizeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summarizeValue(v)
    }
    return out
  }
  return value
}
