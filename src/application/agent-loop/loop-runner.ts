/**
 * Agent 回合执行（M2：direct 直答；M3/M8+：工具循环 + 计划 + 任务分派）。
 * 回合事件序列：turn_start → [plan] → (tool_call/tool_result)* → [任务分派审计] → thought(推理，有则落盘)
 *   → message 整体落盘(message.commit) → turn_end。
 * 先盘后推（memory.md §2）：message 与全部审计事件先写 log 再广播。
 * think 展示：模型 reasoning 增量经 thought.chunk 推前端，流结束合并为 thought 事件落盘。
 * 工具循环（2026-09-09）：模型 function-calling → 白名单工具执行 → 结果回注 → 至多 maxSteps 步。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { SessionLogEvent, SessionMeta } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'
import { ModelGateway } from '../../infra/model/gateway.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import type { OccupancyStore } from '../dispatcher/occupancy-store.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'
import type { ChatMessage, ChatToolCall, ToolSchema } from '../../infra/model/provider.js'
import type { ToolResult } from '../../infra/tools/executor.js'

export interface TurnContext {
  projectId: string
  sessionId: string
  member: TeamMemberConfig
  /** 项目名/场景设定 */
  scenario: string
  /** 可指派对象（分派提示用；由上层按项目团队注入） */
  assignableMembers?: Array<{ instanceId: string; displayName: string }>
}

/** 当前激活任务（注入提示 + workdir_edit 聚合锚点）。 */
export interface ActiveTask {
  id: string
  title: string
  desc: string
}

/** 工具运行时钩子（由组合根注入；缺省则回合不启用工具）。 */
export interface ToolRuntimeHook {
  /** 该会话可用工具（角色白名单 ∩ 注册表 ∩ availableIn） */
  listTools: (ctx: TurnContext, sessionType: string) => ToolSchema[]
  /** 执行工具（内部用 buildToolEnv 注入当前任务） */
  exec: (
    ctx: TurnContext,
    sessionType: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>
  /** 高危命令审批：返回审批 id（无则 null） */
  requestApproval?: (
    ctx: TurnContext,
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ) => Promise<string | null>
  /** 当前激活任务（in_progress 且属本会话） */
  activeTask?: (ctx: TurnContext) => Promise<ActiveTask | null>
  /** 单回合最多工具步数（缺省 6） */
  maxSteps?: number
}

/**
 * 任务分派钩子（甲模式，后绑定）：在正文流完成、message 落盘前执行。
 * 返回追加到回复末尾的平台说明（无分派意图时返回空串）。
 */
export interface TaskDispatchHook {
  run: (ctx: TurnContext, text: string) => Promise<string>
}

export interface AgentLoopRunnerOptions {
  store: SessionStore
  gateway: ModelGateway
  bus: EventBus
  occupancy?: OccupancyStore
  /** 每回合 window 注入的消息上限（config.context.session.rawWindow） */
  windowSize?: number
  /** 任务分派钩子：仅在启用甲模式时注入（后绑定，见 composition） */
  taskDispatch?: TaskDispatchHook
  /** 工具运行时：注入后启用 function-calling 工具循环 */
  toolRuntime?: ToolRuntimeHook
}

/** 思考/推理文本落盘上限（超长截断，防 log 膨胀） */
const MAX_REASONING_CHARS = 20000
/** 工具结果回注模型的上限 */
const MAX_TOOL_RESULT_CHARS = 8000
/** 允许直接派发任务的角色（项目经理/产品经理） */
const DISPATCH_ROLES = new Set(['pm', 'product'])

export class AgentLoopRunner {
  constructor(private readonly opts: AgentLoopRunnerOptions) {}

  /** 执行一个 direct 回合；返回最终消息事件。回合期占用 occupancy(working)，结束释放。 */
  async runDirectTurn(ctx: TurnContext): Promise<SessionLogEvent> {
    const { occupancy } = this.opts
    const iid = ctx.member.instanceId
    if (occupancy) {
      await occupancy.acquire(ctx.projectId, iid, ctx.sessionId, 'working')
      this.opts.bus.emit('agent.state', ctx.projectId, ctx.sessionId, {
        instanceId: iid,
        state: 'working',
        sessionId: ctx.sessionId,
      })
    }
    try {
      return await this.runTurnCore(ctx)
    } finally {
      if (occupancy) {
        await occupancy.release(ctx.projectId, iid)
        this.opts.bus.emit('agent.state', ctx.projectId, ctx.sessionId, {
          instanceId: iid,
          state: 'idle',
          sessionId: null,
        })
      }
    }
  }

  private async runTurnCore(ctx: TurnContext): Promise<SessionLogEvent> {
    const { store } = this.opts
    const meta = await store.readMeta(ctx.projectId, ctx.sessionId)
    const turn = await this.nextTurn(ctx.projectId, ctx.sessionId)
    const sessionType = String(meta.type)
    const turnId = `${ctx.sessionId}:${turn}`

    const activeTask = await this.opts.toolRuntime?.activeTask?.(ctx).catch(() => null)
    const tools = this.opts.toolRuntime?.listTools(ctx, sessionType) ?? []
    const system = this.buildSystemPrompt(ctx, sessionType, activeTask ?? null, tools)
    const history = await this.buildHistory(ctx)
    await store.appendEvent(meta, {
      kind: 'turn_start',
      sender: ctx.member.instanceId,
      payload: { turnId, loopStep: 'act' },
    })
    // plan-execute：回合开始即落计划/进度事件（data-storage §4.2 断点恢复依据）
    if ((ctx.member.loop?.strategy ?? 'direct') === 'plan-execute') {
      const planEvent = await store.appendEvent(meta, {
        kind: 'plan',
        sender: ctx.member.instanceId,
        payload: {
          turnId,
          planId: `${ctx.sessionId}:${turn}:p`,
          steps: [{ step: 1, title: '执行任务并汇报' }],
          stepIndex: 1,
          status: 'executing',
        },
      })
      this.opts.bus.emitLogEvent(ctx.projectId, planEvent)
    }
    this.opts.bus.emitSessionUpdated(ctx.projectId, ctx.sessionId, {
      state: meta.state,
      lastTurn: turn,
    })

    const convo: ChatMessage[] = [{ role: 'system', content: system }, ...history]
    const textParts: string[] = []
    let reasoning = ''
    const maxSteps = Math.max(1, this.opts.toolRuntime?.maxSteps ?? 6)
    try {
      for (let step = 0; step < maxSteps; step++) {
        let stepText = ''
        const calls = new Map<number, { id?: string; name?: string; args: string }>()
        for await (const item of this.opts.gateway.streamChat({
          providerId: ctx.member.model,
          messages: convo,
          tools: tools.length ? tools : undefined,
        })) {
          if (item.content) {
            stepText += item.content
            this.opts.bus.emitChunk(ctx.projectId, ctx.sessionId, {
              turnId,
              delta: item.content,
              sender: ctx.member.instanceId,
            })
          }
          if (item.reasoning) {
            reasoning += item.reasoning
            this.opts.bus.emitThoughtChunk(ctx.projectId, ctx.sessionId, {
              turnId,
              delta: item.reasoning,
              sender: ctx.member.instanceId,
            })
          }
          if (item.toolCall) {
            const cur = calls.get(item.toolCall.index) ?? { args: '' }
            if (item.toolCall.id) cur.id = item.toolCall.id
            if (item.toolCall.name) cur.name = item.toolCall.name
            if (item.toolCall.argumentsDelta) cur.args += item.toolCall.argumentsDelta
            calls.set(item.toolCall.index, cur)
          }
        }
        if (stepText.trim()) textParts.push(stepText.trim())
        if (!calls.size || !this.opts.toolRuntime) break

        const toolCalls: ChatToolCall[] = []
        const toolMessages: ChatMessage[] = []
        const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0])
        for (const [index, cur] of ordered) {
          const name = cur.name ?? ''
          const id = cur.id ?? `call_${turn}_${index}`
          toolCalls.push({ id, name, arguments: cur.args || '{}' })
          const args = parseToolArgs(cur.args)
          await this.appendAudit(ctx, meta, 'tool_call', {
            tool: name,
            input: summarizeValue(args),
          })
          let result: ToolResult
          if (!args) {
            result = { ok: false, code: ErrorCodes.VALIDATION, reason: '工具参数不是合法 JSON' }
          } else {
            try {
              result = await this.opts.toolRuntime.exec(ctx, sessionType, name, args)
            } catch (e) {
              result = {
                ok: false,
                code: e instanceof AppError ? e.code : ErrorCodes.INTERNAL,
                reason: String(e instanceof Error ? e.message : e),
              }
            }
          }
          if (
            !result.ok &&
            result.code === 'CMD_APPROVAL_REQUIRED' &&
            this.opts.toolRuntime.requestApproval
          ) {
            const approvalId = await this.opts.toolRuntime
              .requestApproval(ctx, name, args ?? {}, result)
              .catch(() => null)
            if (approvalId) {
              result = {
                ok: false,
                code: 'APPROVAL_PENDING',
                reason: `已提交审批 ${approvalId}，等待用户批准后由平台执行；请向用户说明并继续其余工作`,
                approvalId,
              }
            }
          }
          await this.appendAudit(ctx, meta, 'tool_result', {
            tool: name,
            ...(result.ok
              ? { ok: true, summary: cut(String(result.summary ?? ''), 500) }
              : { ok: false, code: result.code, reason: cut(result.reason, 300) }),
          })
          toolMessages.push({
            role: 'tool',
            toolCallId: id,
            content: cut(JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
          })
        }
        convo.push({ role: 'assistant', content: stepText, toolCalls })
        convo.push(...toolMessages)
      }
    } catch (err) {
      // 模型失败：记录 error 事件并回退降级文本（agent-runtime §7）
      const errEvent = await store.appendEvent(meta, {
        kind: 'error',
        sender: ctx.member.instanceId,
        role: 'system',
        payload: {
          errorCode: err instanceof AppError ? err.code : ErrorCodes.MODEL,
          message: String(err instanceof Error ? err.message : err).slice(0, 300),
        },
      })
      this.opts.bus.emitLogEvent(ctx.projectId, errEvent)
      textParts.push(`（模型调用失败：${err instanceof Error ? err.message : err}）`)
    }
    const text = textParts.join('\n')

    // 甲模式任务分派（pm/product 的 user 会话）：解析模型文本中的分派指令并执行；
    // 结果以平台说明追加进最终消息（诚实反馈登记/开工/排队/失败）。失败不影响回合。
    let dispatchNote = ''
    if (this.dispatchEligible(ctx, sessionType)) {
      dispatchNote = await this.opts.taskDispatch!.run(ctx, text).catch(
        (e: unknown) =>
          `\n\n【系统】任务分派处理失败：${String(e instanceof Error ? e.message : e)}`,
      )
    }
    const finalText = text + dispatchNote

    // 思考事件落盘（先于 message，语义上思考先于正文）
    const thoughtText = reasoning.trim()
    if (thoughtText) {
      const thoughtEvent = await store.appendEvent(meta, {
        kind: 'thought',
        role: 'agent',
        sender: ctx.member.instanceId,
        content: { text: cut(thoughtText, MAX_REASONING_CHARS, '\n…(思考过长已截断)'), blocks: [] },
        payload: { turnId },
      })
      this.opts.bus.emitLogEvent(ctx.projectId, thoughtEvent)
    }

    // 完整消息落盘（一条 message 事件，D14-⑦ 流式文本整体落盘）
    const msgEvent = await store.appendEvent(meta, {
      kind: 'message',
      role: 'agent',
      sender: ctx.member.instanceId,
      content: { text: finalText, blocks: [] },
      model: ctx.member.model,
      payload: { turnId },
    })
    // 先盘后推：commit 在 message 事件广播后
    this.opts.bus.emitLogEvent(ctx.projectId, msgEvent)
    this.opts.bus.emitCommit(ctx.projectId, ctx.sessionId, {
      seq: msgEvent.seq,
      turnId,
    })

    await store.appendEvent(meta, {
      kind: 'turn_end',
      sender: ctx.member.instanceId,
      payload: { turnId, ok: true },
    })
    return msgEvent
  }

  /** 审计事件（tool_call/tool_result）：先盘后推。 */
  private async appendAudit(
    ctx: TurnContext,
    meta: SessionMeta,
    kind: 'tool_call' | 'tool_result',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const evt = await this.opts.store.appendEvent(meta, {
      kind,
      role: 'agent',
      sender: ctx.member.instanceId,
      payload,
    })
    this.opts.bus.emitLogEvent(ctx.projectId, evt)
  }

  /** 是否可执行甲模式分派：启用钩子 + user 会话 + 管理/产品角色。 */
  private dispatchEligible(ctx: TurnContext, sessionType: string): boolean {
    return (
      !!this.opts.taskDispatch &&
      sessionType === 'user' &&
      DISPATCH_ROLES.has(ctx.member.roleTemplateId)
    )
  }

  private async nextTurn(projectId: string, sessionId: string): Promise<number> {
    const all = await this.opts.store.readWindow(projectId, sessionId, { limit: 100000 })
    let max = 0
    for (const e of all) if (typeof e.turn === 'number' && e.turn > max) max = e.turn
    return max + 1
  }

  private buildSystemPrompt(
    ctx: TurnContext,
    sessionType: string,
    activeTask: ActiveTask | null,
    tools: ToolSchema[],
  ): string {
    const m = ctx.member
    const strategy = m.loop?.strategy ?? 'direct'
    const strategyHint: Record<string, string> = {
      direct: '采用直接作答方式。',
      reflective: '先给出初稿，再自查一遍（覆盖边界与漏洞）后输出修订版结论。',
      'plan-execute': '先给出简短执行计划，再按计划逐步说明并输出结论。',
    }
    const parts = [
      m.prompt ?? '',
      '',
      `[场景设定] 你是「${m.displayName}」（项目：${ctx.scenario}）。用户是你的老板与最终决策者。`,
      `[执行模式] ${strategyHint[strategy] ?? strategyHint.direct}`,
      '回复要求：中文、简洁、直接给结论；涉及需要用户拍板/审批的事项必须明确说明，不替用户做决定。',
    ]
    if (tools.length) {
      parts.push(
        `[可用工具] ${tools.map((t) => t.name).join('、')}。` +
          '需要查看/修改工作目录或检索信息时请直接调用工具，不要凭空猜测文件内容；' +
          '写工作目录用 workdir_edit，运行命令用 cmd_run（高危命令会转用户审批）；完成后汇报改了什么、验证结果。',
      )
    }
    if (activeTask) {
      parts.push(
        `[当前任务] ${activeTask.id}「${activeTask.title}」（in_progress）` +
          (activeTask.desc ? `：${activeTask.desc}` : '') +
          '\n请围绕该任务工作；代码改动会自动归属该任务，完成后向用户汇报。',
      )
    }
    const hint = this.buildDispatchHint(ctx, sessionType)
    if (hint) parts.push(hint)
    return parts.join('\n')
  }

  /** 甲模式分派说明（pm/product 的 user 会话且提供了可派对象时注入）。 */
  private buildDispatchHint(ctx: TurnContext, sessionType: string): string | null {
    if (!this.dispatchEligible(ctx, sessionType)) return null
    const peers = (ctx.assignableMembers ?? []).filter((x) => x.instanceId !== ctx.member.instanceId)
    if (!peers.length) return null
    const list = peers.map((p) => `${p.instanceId}（${p.displayName}）`).join('、')
    return [
      '[任务分派（甲模式已开启）] 当用户要求你拆解/安排/指派开发任务时：',
      '1. 先用自然语言说明你的安排（做什么、交给谁、为什么）；',
      '2. 然后在回复末尾输出一个 json 代码块，逐项列出要创建的任务，例如：',
      '```json',
      '[{"assignee":"dev_1","title":"实现登录接口","desc":"补充边界与验收说明","start":true}]',
      '```',
      `3. 约束：assignee 必须来自可指派对象——${list}；不可捏造实例 id。`,
      '4. start=true 表示创建后立即开工（受派者空闲时平台会自动触发）；对方已有进行中任务时平台自动保持排队并说明。',
      '5. 平台会在回复末尾自动追加登记结果，你无需虚构“已创建成功”。',
    ].join('\n')
  }

  private async buildHistory(ctx: TurnContext): Promise<ChatMessage[]> {
    const window = await this.opts.store.readTail(
      ctx.projectId,
      ctx.sessionId,
      this.opts.windowSize ?? 60,
    )
    const out: ChatMessage[] = []
    for (const e of window) {
      if (e.kind !== 'message') continue
      if (e.role === 'user' && e.content) {
        out.push({ role: 'user', content: e.content.text })
      } else if (e.role === 'agent' && e.sender === ctx.member.instanceId && e.content) {
        out.push({ role: 'assistant', content: e.content.text })
      }
    }
    return out
  }
}

/** 解析工具参数 JSON；非法返回 null（调用方回注错误）。 */
function parseToolArgs(raw: string): Record<string, unknown> | null {
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
function cut(text: string, max: number, suffix = '…(已截断)'): string {
  return text.length > max ? text.slice(0, max) + suffix : text
}

/** 审计用参数摘要：长字符串截断，避免把整份文件写进事件。 */
function summarizeValue(value: unknown): unknown {
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
