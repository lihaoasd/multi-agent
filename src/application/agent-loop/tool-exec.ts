/**
 * 一步之内的工具调用执行（P3g 从 `loop-runner.ts` 抽出，2026-09-14）。
 *
 * 一步里模型可能给出多个工具调用，本模块负责**逐个执行并审计**，同时做三件与产品语义
 * 强相关的事：
 *
 *  1. **审批桥（阻塞式）**：`cmd_run` 命中高危 → 提交审批并返回 `APPROVAL_PENDING`，
 *     本回合立即结束，角色进入「等待你处理」；用户批准/拒绝后由 API 层回注结果并唤醒
 *     （不再"边等边干"，2026-09-12 定稿）。
 *  2. **挂起语义**：`ask_user`（等待用户决策）与待批审批都会让本回合停下；
 *     同一步里若模型并发给了多个 `ask_user`，第一个挂起后**不再执行后续调用**
 *     （否则会出现多条"已有待回答的问题"失败行，用户看着像报了两次错）。
 *  3. **无进展检测**：同一「工具 + 入参 + 结果」**连续**重复 `REPEAT_STALL_LIMIT` 次
 *     → 判定原地空转，由调用方收尾（这是"无限轮"的安全阀）。
 *
 * 行为与原实现逐字一致；依赖通过 `ToolExecDeps` 注入，因此不绑定 runner 实例。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { ChatMessage, ChatToolCall } from '../../infra/model/provider.js'
import type { ToolResult } from '../../infra/tools/executor.js'
import type { SessionMeta } from '../../shared/types/session.js'
import type { TurnContext } from './loop-runner.js'
import {
  MAX_TOOL_RESULT_CHARS,
  REPEAT_STALL_LIMIT,
  cut,
  parseToolArgs,
  summarizeValue,
} from './loop-helpers.js'

/** 工具执行所需的最小依赖（由 runner 提供）。 */
export interface ToolExecDeps {
  /** 执行工具（角色白名单 ∩ 会话类型 ∩ 注册表已由装配层过滤） */
  exec: (
    ctx: TurnContext,
    sessionType: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>
  /** 高危命令审批桥：返回审批 id；null 表示无需/未提交审批 */
  requestApproval?: (
    ctx: TurnContext,
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ) => Promise<string | null>
  /** 审计事件落盘（先盘后推由 runner 保证） */
  appendAudit: (
    ctx: TurnContext,
    meta: SessionMeta,
    kind: 'tool_call' | 'tool_result',
    payload: Record<string, unknown>,
  ) => Promise<void>
}

/** 一步内已累积的工具调用增量。 */
export interface PendingToolCall {
  id?: string
  name?: string
  args: string
}

export interface ExecToolCallsInput {
  ctx: TurnContext
  meta: SessionMeta
  turn: string | number
  ordered: Array<[number, PendingToolCall]>
  sessionType: string
  calledTools: Set<string>
  /** 无进展检测的连续计数（跨 step 复用；缺省则不检测） */
  repeatCounts?: Map<string, number>
}

export interface ExecToolCallsResult {
  toolCalls: ChatToolCall[]
  toolMessages: ChatMessage[]
  stalled: boolean
  /** 有工具要求挂起（ask_user / 待批审批）→ 调用方立即结束本回合 */
  suspended: boolean
}

/** 执行一步里的工具调用（审计 + 审批桥 + 结果回注 + 空转检测）。 */
export async function execToolCalls(
  deps: ToolExecDeps,
  input: ExecToolCallsInput,
): Promise<ExecToolCallsResult> {
  const { ctx, meta, turn, ordered, sessionType, calledTools, repeatCounts } = input
  const toolCalls: ChatToolCall[] = []
  const toolMessages: ChatMessage[] = []
  let stalled = false
  let suspended = false
  for (const [index, cur] of ordered) {
    // 同一步里若模型并发给了多个 ask_user：第一个挂起后**不再执行后续调用**
    // （否则会多出 "已有待回答的问题" 的失败行，用户看到像是报了两次错）
    if (suspended) break
    const name = cur.name ?? ''
    const id = cur.id ?? `call_${String(turn)}_${index}`
    toolCalls.push({ id, name, arguments: cur.args || '{}' })
    calledTools.add(name)
    const args = parseToolArgs(cur.args)
    await deps.appendAudit(ctx, meta, 'tool_call', {
      callId: id,
      tool: name,
      input: summarizeValue(args),
    })
    let result: ToolResult
    if (!args) {
      result = { ok: false, code: ErrorCodes.VALIDATION, reason: '工具参数不是合法 JSON' }
    } else {
      try {
        result = await deps.exec(ctx, sessionType, name, args)
      } catch (e) {
        result = {
          ok: false,
          code: e instanceof AppError ? e.code : ErrorCodes.INTERNAL,
          reason: String(e instanceof Error ? e.message : e),
        }
      }
    }
    if (!result.ok && result.code === 'CMD_APPROVAL_REQUIRED' && deps.requestApproval) {
      const approvalId = await deps
        .requestApproval(ctx, name, args ?? {}, result)
        .catch(() => null)
      if (approvalId) {
        // **审批是阻塞式的**（2026-09-12）：提交审批后本回合立即结束，角色进入「等待你处理」；
        // 用户批准/拒绝后由 API 层把结果回注会话并唤醒角色继续（不再"边等边干"）。
        result = {
          ok: false,
          code: 'APPROVAL_PENDING',
          reason:
            `已提交审批 ${approvalId}，**本轮到此结束**：你现在在等用户批准这个动作。` +
            '不要重复申请、也不要改用其他方式绕过；用户批准后平台会执行并把结果回给你，然后你继续。',
          approvalId,
        }
      }
    }
    await deps.appendAudit(ctx, meta, 'tool_result', {
      callId: id,
      tool: name,
      ...(result.ok
        ? { ok: true, summary: cut(String(result.summary ?? ''), 500) }
        : {
            ok: false,
            code: result.code,
            reason: cut(result.reason, 300),
            ...(result.approvalId ? { approvalId: result.approvalId } : {}),
          }),
    })
    // 无进展检测：同工具 + 同入参 + 同结果 → 计数；出现新签名则清空旧计数（要求"连续"重复）
    if (repeatCounts) {
      const sig = `${name}|${cur.args || '{}'}|${JSON.stringify(result).slice(0, 300)}`
      for (const key of [...repeatCounts.keys()]) if (key !== sig) repeatCounts.delete(key)
      const n = (repeatCounts.get(sig) ?? 0) + 1
      repeatCounts.set(sig, n)
      if (n >= REPEAT_STALL_LIMIT) stalled = true
    }
    toolMessages.push({
      role: 'tool',
      toolCallId: id,
      content: cut(JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
    })
    // 挂起类：ask_user（等待用户决策）与审批待批（等待用户批准）都结束本回合
    if ((result.ok && result.suspend === true) || (!result.ok && result.code === 'APPROVAL_PENDING')) {
      suspended = true
    }
  }
  return { toolCalls, toolMessages, stalled, suspended }
}
