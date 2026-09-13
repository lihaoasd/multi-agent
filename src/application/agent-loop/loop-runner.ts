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
import type { AgentRuntimeState } from '../runtime-state.js'
import {
  buildSystemPrompt,
  isDispatchEligible,
  type ActiveTask,
  type BoardTask,
  type FileOwnership,
  type PendingTask,
} from './system-prompt.js'

/**
 * 提示词拼装与相关类型已抽到 `./system-prompt.ts`（2026-09-13，单点真相）：
 * 运行期（本文件）与「完整系统提示词预览」共用，这里按既有 import 路径 re-export。
 */
export type { ActiveTask, PendingTask, BoardTask, FileOwnership } from './system-prompt.js'

export interface TurnContext {
  projectId: string
  sessionId: string
  member: TeamMemberConfig
  /** 项目名/场景设定 */
  scenario: string
  /** 团队名册（所有角色都注入；由上层按项目团队提供） */
  assignableMembers?: Array<{ instanceId: string; displayName: string; roleTemplateId?: string }>
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
  /** 待领取任务（任务栏上派给我、尚未领取的；用于 [待领取任务] 提示块） */
  pendingTasks?: (ctx: TurnContext) => Promise<PendingTask[]>
  /** 任务栏活跃任务（todo/in_progress）：给 pm/product 注入 [任务栏现状]，避免两人重复派同一件事 */
  boardTasks?: (ctx: TurnContext) => Promise<BoardTask[]>
  /** 产出物归属（署名）：注入 [我的产出物] / [他人产出物（只读）] */
  fileOwnership?: (ctx: TurnContext) => Promise<FileOwnership>
  /**
   * 单回合工具步数上限：**缺省不限制（无限轮）**，模型不再调用工具时自然结束。
   * 传正数则作为硬上限（测试/特殊场景用）。为防止"原地空转"，另有无进展保护：
   * 同一工具 + 同一入参 + 同一结果连续重复 REPEAT_STALL_LIMIT 次即停。
   */
  maxSteps?: number
  /**
   * 回合结束（占用释放后）统一 flush 挂起类工具的推送（如 ask_user 的 question.asked）。
   * 目的是让"提问卡片出现"与"角色进入等待你处理"发生在同一时刻。
   */
  flushDeferred?: (ctx: TurnContext) => Promise<void>
  /**
   * 角色当前运行态（单点推导，application/runtime-state.ts）：由组合根读取 pending 提问/审批后计算。
   * 用途：① 回合开始前判断角色是否在「等待你处理」——是则**不开工**，避免出现"工作中 + 待答卡片"；
   *       ② 回合结束广播 `agent.state` 时给出与 `GET /agents` 完全一致的状态。
   */
  runtimeState?: (ctx: TurnContext) => Promise<AgentRuntimeState>
  /**
   * step 边界闸门（2026-09-13）：每执行完一步工具后询问"是否该停下当前工作"。
   * 返回非空字符串 = 停止本回合、不跑收尾，并把该文本作为**系统消息落盘**（角色下一轮可见原因）。
   * 首个使用者：被会议邀请（平台已记报到）→ 角色把当前 step 跑完就停手、去开会。
   */
  shouldYield?: (ctx: TurnContext) => Promise<string | null>
}

/**
 * 任务分派钩子（甲模式，后绑定）：在正文流完成、message 落盘前执行。
 * 返回追加到回复末尾的平台说明（无分派意图时返回空串）。
 */export interface TaskDispatchHook {
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
/** 收尾回合只暴露的收尾三件套工具（不再开新工作）。 */
const CLOSURE_TOOLS = new Set(['task_update', 'task_claim', 'artifact_submit', 'ask_user'])
/** 收尾回合的提示（步数用尽/模型空手停下/检测到空转时注入，确保任务状态与用户总结不会丢） */
const WRAPUP_PROMPT =
  '【平台】现在进入**收尾**：不要开始新工作。请立刻完成两件事：' +
  '① 若你有进行中的任务且本轮已完成，调用 task_update（taskId 可省略，state=done，note=一句话完成总结）；' +
  '② 用一段话给出**面向用户的完成总结**：做了什么、产出文件（工作目录相对路径）、验证结果、遗留问题与建议。'
/** 无进展保护：同一工具+入参+结果连续重复这么多次 → 判定空转并收尾（无限轮时的安全阀） */
const REPEAT_STALL_LIMIT = 3
/**
 * 角色在「等待你处理」期间被唤醒时返回的占位事件：本回合**没有开工**（不占 occupancy、不调模型），
 * 唤醒消息已落盘，等用户答复后由下一回合带着它继续。回执调用方不使用该返回值。
 */
const SKIPPED_TURN: SessionLogEvent = {
  seq: 0,
  ts: new Date(0).toISOString(),
  sessionId: '',
  kind: 'turn_end',
  payload: { skipped: 'waiting_user' },
}

export class AgentLoopRunner {
  constructor(private readonly opts: AgentLoopRunnerOptions) {}

  /** 执行一个 direct 回合；返回最终消息事件。回合期占用 occupancy(working)，结束释放。 */
  async runDirectTurn(ctx: TurnContext): Promise<SessionLogEvent> {
    const { occupancy } = this.opts
    const iid = ctx.member.instanceId
    // 角色是否在「等待你处理」（有待答提问/待批审批）：
    // 这种状态下**不开工**——它只能再问一次用户，硬跑一轮只会让左栏显示"工作中"而卡片还在等用户。
    const runtime = await this.opts.toolRuntime?.runtimeState?.(ctx)
    const onStandby = runtime === 'waiting'
    if (occupancy && !onStandby) {
      await occupancy.acquire(ctx.projectId, iid, ctx.sessionId, 'working')
      this.opts.bus.emit('agent.state', ctx.projectId, ctx.sessionId, {
        instanceId: iid,
        state: 'working',
        sessionId: ctx.sessionId,
      })
    } else if (occupancy) {
      // 等待用户期间也广播一次：前端即时把该角色显示成「等待你处理」
      this.opts.bus.emit('agent.state', ctx.projectId, ctx.sessionId, {
        instanceId: iid,
        state: 'waiting',
        sessionId: ctx.sessionId,
      })
    }
    try {
      if (onStandby) return SKIPPED_TURN
      return await this.runTurnCore(ctx)
    } finally {
      if (occupancy) {
        // 只释放本回合会话的占用：回合中若已入会，会议占用不能被清掉
        await occupancy.release(ctx.projectId, iid, ctx.sessionId)
        if (!onStandby) {
          // 会议会话内的发言回合结束后，恢复到「会议中」（成员仍在会）
          if (ctx.sessionId.startsWith('m_')) {
            await occupancy
              .acquire(ctx.projectId, iid, ctx.sessionId, 'meeting')
              .catch(() => undefined)
          }
          // 状态单点推导：有待答提问/待批审批 → waiting（不能只按 occupancy 广播，
          // 否则会出现"左栏工作中、卡片却在等用户"的错位）
          const state =
            (await this.opts.toolRuntime?.runtimeState?.(ctx).catch(() => undefined)) ??
            (await occupancy.get(ctx.projectId, iid).catch(() => null))?.activity ??
            'idle'
          this.opts.bus.emit('agent.state', ctx.projectId, ctx.sessionId, {
            instanceId: iid,
            state,
            sessionId: ctx.sessionId,
          })
        }
      }
      // 回合结束、占用已释放 → 再广播本回合积压的提问（ask_user）：
      // 顺序 = 角色消息落盘 → 状态转「等待你处理」→ 提问卡片出现，前端不会再看到时间错位。
      await this.opts.toolRuntime?.flushDeferred?.(ctx).catch(() => undefined)
    }
  }

  private async runTurnCore(ctx: TurnContext): Promise<SessionLogEvent> {
    const { store } = this.opts
    const meta = await store.readMeta(ctx.projectId, ctx.sessionId)
    const turn = await this.nextTurn(ctx.projectId, ctx.sessionId)
    const sessionType = String(meta.type)
    const turnId = `${ctx.sessionId}:${turn}`

    const activeTask = await this.opts.toolRuntime?.activeTask?.(ctx).catch(() => null)
    const pendingTasks = await this.opts.toolRuntime?.pendingTasks?.(ctx).catch(() => null)
    const boardTasks = await this.opts.toolRuntime?.boardTasks?.(ctx).catch(() => null)
    const ownership = await this.opts.toolRuntime?.fileOwnership?.(ctx).catch(() => null)
    const tools = this.opts.toolRuntime?.listTools(ctx, sessionType) ?? []
    const system = buildSystemPrompt({
      member: ctx.member,
      scenario: ctx.scenario,
      sessionType,
      assignableMembers: ctx.assignableMembers ?? [],
      activeTask: activeTask ?? null,
      pendingTasks: pendingTasks ?? [],
      boardTasks: boardTasks ?? [],
      ownership: ownership ?? null,
      toolNames: tools.map((t) => t.name),
      dispatchEligible: this.dispatchEligible(ctx, sessionType),
    })
    const history = await this.buildHistory(ctx)
    const turnStartEvt = await store.appendEvent(meta, {
      kind: 'turn_start',
      sender: ctx.member.instanceId,
      payload: { turnId, loopStep: 'act' },
    })
    // 广播回合边界：前端据此判断"本轮结束"（提问卡片/状态刷新都靠它对齐时序）
    this.opts.bus.emitLogEvent(ctx.projectId, turnStartEvt)
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
    /** 已落盘的步骤正文（拼起来供分派解析与兜底判断） */
    const flushedTexts: string[] = []
    /** 最后一步已收到、尚未落盘的正文（等分派说明合并后再落一条消息） */
    let pendingText = ''
    let thoughtCount = 0
    let failureText = ''
    let lastSeq = 0
    // 单回合工具步数：**缺省无限轮**（模型不再调用工具即结束）；只有显式传正数才设硬上限。
    // 无限轮的安全阀是"无进展保护"（见下）：同一工具+入参+结果连续重复 REPEAT_STALL_LIMIT 次即收尾。
    const configuredSteps = this.opts.toolRuntime?.maxSteps ?? 0
    const stepLimit = configuredSteps > 0 ? configuredSteps : Number.POSITIVE_INFINITY
    /** 本回合调用过的工具名（用于回合末兜底提示：任务状态是否上报） */
    const calledTools = new Set<string>()
    /** 无进展保护：签名 → 连续重复次数 */
    const repeatCounts = new Map<string, number>()
    let toolCallCount = 0
    let exhausted = false
    /** 检测到原地空转（重复同样调用）→ 收尾 */
    let stalled = false
    /** 模型"空手停下"（有工具调用但最后一步没有任何正文/工具）→ 也走一次收尾回合 */
    let silentStop = false
    /** 角色因提问进入「等待用户决策」→ 本回合到此为止（不跑收尾、不催任务状态） */
    let suspendedForUser = false
    /** step 边界闸门要求停下（如被拉进会议）→ 结束本回合、不跑收尾 */
    let yieldedForMeeting = false
    let wrappedUp = false
    /** 只出思考/预算被截断时，允许一次"少推理、直接输出"的重试（每回合至多一次） */
    let nudged = false
    try {
      for (let step = 0; step < stepLimit; step++) {
        const streamed = await this.streamStep(ctx, convo, turnId, tools)
        const { stepText, stepReasoning, calls, finishReason } = streamed
        // 步骤边界：按时间顺序落盘本步的「思考 → 正文」。
        // 有工具调用的步骤必须立即落盘，否则刷新后（历史按 seq 回放）顺序会与实时不一致。
        if (stepReasoning.trim()) {
          lastSeq = await this.appendThought(ctx, meta, stepReasoning, turnId)
          thoughtCount++
        }
        if (!calls.size || !this.opts.toolRuntime) {
          // 推理型模型常见失败：思考吃满输出预算（finish_reason=length）或只思考不输出 →
          // 本回合没有正文也没有工具调用就结束了。重试一次，明确要求"直接输出/调用工具"。
          const bareStep = !stepText.trim() && !calls.size
          const truncated = finishReason === 'length'
          if (bareStep && (stepReasoning.trim() || truncated) && !nudged) {
            nudged = true
            convo.push({
              role: 'system',
              content:
                '【平台】上一步只产生了思考，没有正文也没有工具调用' +
                (truncated ? '（输出预算已被推理占满）' : '') +
                '。请**直接继续**：需要动手就立刻调用工具；否则给出面向用户的结论/总结。' +
                '不要再写出长篇推理。',
            })
            continue
          }
          pendingText = stepText.trim() // 最后一步：待分派说明合并后落一条消息
          // 模型没给正文就结束（常见：拿到工具结果后直接停）→ 交给收尾回合补状态与总结
          if (!pendingText && !stepReasoning.trim() && toolCallCount > 0) silentStop = true
          break
        }
        if (stepText.trim()) {
          lastSeq = await this.appendStepMessage(ctx, meta, stepText.trim(), turnId)
          flushedTexts.push(stepText.trim())
        }

        const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0])
        const {
          toolCalls,
          toolMessages,
          stalled: hitStall,
          suspended,
        } = await this.execToolCalls(
          ctx,
          meta,
          turnId,
          ordered,
          sessionType,
          calledTools,
          repeatCounts,
        )
        toolCallCount += toolCalls.length
        convo.push({ role: 'assistant', content: stepText, toolCalls })
        convo.push(...toolMessages)
        if (suspended) {
          // 角色进入「等待用户决策」（ask_user）：**立即结束本回合**，不再继续调用工具/执行任务。
          // 卡片/通知会在回合结束、占用释放后再推送（见 runDirectTurn 的 flushDeferred）。
          pendingText = stepText.trim()
          suspendedForUser = true
          break
        }
        if (hitStall) {
          // 无限轮 + 模型原地重复同一调用 → 停在这里，避免无限空转烧预算
          stalled = true
          const note = await this.opts.store.appendEvent(meta, {
            kind: 'message',
            role: 'user',
            sender: 'system',
            content: {
              text:
                `【系统】检测到连续 ${REPEAT_STALL_LIMIT} 次完全相同的工具调用且结果相同（原地空转），` +
                '本回合已停止。若任务未完成，请调整思路（换参数/换工具）后重试。',
              blocks: [],
            },
            payload: { turnId, system: true },
          })
          this.opts.bus.emitLogEvent(ctx.projectId, note)
          break
        }
        if (Number.isFinite(stepLimit) && step === stepLimit - 1) exhausted = true
        // step 边界闸门（2026-09-13）：本步工具已执行、结果已回注 → 再问"是否该停手"。
        // 被会议邀请时在此停下：**不跑收尾**（任务是被会议打断，不是完成），
        // 并把停手原因写成系统消息，角色下一轮/会议会话里能看到"我已入会、等主持人发话"。
        if (!exhausted) {
          const yieldReason = await this.opts.toolRuntime?.shouldYield?.(ctx).catch(() => null)
          if (yieldReason) {
            yieldedForMeeting = true
            const note = await this.opts.store.appendEvent(meta, {
              kind: 'message',
              role: 'user',
              sender: 'system',
              content: { text: yieldReason, blocks: [] },
              payload: { turnId, system: true },
            })
            this.opts.bus.emitLogEvent(ctx.projectId, note)
            break
          }
        }
      }

      // 步数用尽 / 模型空手停下 / 检测到空转 → 收尾回合：只允许"结项/沟通"工具，确保任务状态与用户总结不丢。
      // 注意：因提问而挂起（等待用户决策）时**不**跑收尾——任务是被暂停，不是完成。
      if ((exhausted || silentStop || stalled) && !suspendedForUser && !yieldedForMeeting && this.opts.toolRuntime && !wrappedUp) {
        wrappedUp = true
        const wrap = await this.runWrapUp(ctx, meta, turnId, sessionType, convo, tools, calledTools)
        toolCallCount += wrap.toolCalls
        if (wrap.text) pendingText = pendingText ? `${pendingText}\n${wrap.text}` : wrap.text
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
      failureText = `（模型调用失败：${err instanceof Error ? err.message : err}）`
    }

    const mergedText = [...flushedTexts, pendingText].filter(Boolean).join('\n')
    // 甲模式任务分派（pm/product 的 user 会话）：解析整回合文本中的分派指令并执行；
    // 结果以平台说明追加进尾部消息（诚实反馈登记/开工/排队/失败）。失败不影响回合。
    let dispatchNote = ''
    if (this.dispatchEligible(ctx, sessionType)) {
      dispatchNote = await this.opts
        .taskDispatch!.run(ctx, mergedText)
        .catch(
          (e: unknown) =>
            `\n\n【系统】任务分派处理失败：${String(e instanceof Error ? e.message : e)}`,
        )
    }

    // 尾部消息 = 最后一步正文 + 失败说明 + 平台分派说明；本回合完全没有正文时给出兜底。
    // 注意：思考（reasoning）与正文（content）是两路，思考只进 thought 事件，永不作为回复正文。
    const tailParts: string[] = []
    if (pendingText) tailParts.push(pendingText)
    if (failureText) tailParts.push(failureText)
    if (!pendingText && !failureText && flushedTexts.length === 0 && thoughtCount > 0) {
      tailParts.push(
        '（模型本次只给出了思考过程、未输出正文；可直接重试，或调大该 provider 的 maxTokens）',
      )
    }
    let tailText = tailParts.join('\n')
    if (dispatchNote) tailText = tailText ? tailText + dispatchNote : dispatchNote.trim()

    let msgEvent: SessionLogEvent | null = null
    if (tailText || flushedTexts.length === 0) {
      msgEvent = await store.appendEvent(meta, {
        kind: 'message',
        role: 'agent',
        sender: ctx.member.instanceId,
        content: { text: tailText, blocks: [] },
        model: ctx.member.model,
        payload: { turnId },
      })
      // 先盘后推：commit 在 message 事件广播后
      this.opts.bus.emitLogEvent(ctx.projectId, msgEvent)
      lastSeq = msgEvent.seq
    }
    this.opts.bus.emitCommit(ctx.projectId, ctx.sessionId, {
      seq: lastSeq,
      turnId,
    })

    // 回合末兜底：干了活但没上报任务状态 → 追一条系统提示（用户看得见，下一回合模型也看得到）
    await this.remindUnreportedTask(
      ctx,
      meta,
      turnId,
      activeTask ?? null,
      pendingTasks ?? [],
      calledTools,
      toolCallCount,
      Boolean(tailText.trim()),
      // 因提问而挂起时不催"任务仍为进行中"——角色本来就在等用户决策
      // 因提问挂起、或因会议叫走 → 都算"暂停"，不催"任务仍为进行中"
      suspendedForUser || yieldedForMeeting,
    )

    const turnEndEvt = await store.appendEvent(meta, {
      kind: 'turn_end',
      sender: ctx.member.instanceId,
      payload: { turnId, ok: true },
    })
    this.opts.bus.emitLogEvent(ctx.projectId, turnEndEvt)
    return (
      msgEvent ?? {
        seq: lastSeq,
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        kind: 'message',
        role: 'agent',
        sender: ctx.member.instanceId,
        content: { text: tailText, blocks: [] },
        model: ctx.member.model,
        payload: { turnId },
      }
    )
  }

  /** 单步模型流：累积正文/思考/工具调用，并实时推 chunk（返回后由调用方落盘）。 */
  private async streamStep(
    ctx: TurnContext,
    convo: ChatMessage[],
    turnId: string,
    tools: ToolSchema[],
  ): Promise<{
    stepText: string
    stepReasoning: string
    calls: Map<number, { id?: string; name?: string; args: string }>
    finishReason?: string
  }> {
    let stepText = ''
    let stepReasoning = ''
    let finishReason: string | undefined
    const calls = new Map<number, { id?: string; name?: string; args: string }>()
    for await (const item of this.opts.gateway.streamChat({
      providerId: ctx.member.model,
      messages: convo,
      tools: tools.length ? tools : undefined,
    })) {
      if (item.finishReason) finishReason = item.finishReason
      if (item.content) {
        stepText += item.content
        this.opts.bus.emitChunk(ctx.projectId, ctx.sessionId, {
          turnId,
          delta: item.content,
          sender: ctx.member.instanceId,
        })
      }
      if (item.reasoning) {
        stepReasoning += item.reasoning
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
    return { stepText, stepReasoning, calls, finishReason }
  }

  /**
   * 执行一步里的工具调用（审计 + 审批桥 + 结果回注），并登记调用过的工具名。
   * 同时做**无进展检测**：同一「工具+入参+结果」连续重复 REPEAT_STALL_LIMIT 次 → 返回 stalled（由调用方收尾）。
   */
  private async execToolCalls(
    ctx: TurnContext,
    meta: SessionMeta,
    turn: string | number,
    ordered: Array<[number, { id?: string; name?: string; args: string }]>,
    sessionType: string,
    calledTools: Set<string>,
    repeatCounts?: Map<string, number>,
  ): Promise<{
    toolCalls: ChatToolCall[]
    toolMessages: ChatMessage[]
    stalled: boolean
    /** 有工具要求挂起（ask_user）→ 调用方立即结束本回合 */
    suspended: boolean
  }> {
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
      await this.appendAudit(ctx, meta, 'tool_call', {
        callId: id,
        tool: name,
        input: summarizeValue(args),
      })
      let result: ToolResult
      if (!args) {
        result = { ok: false, code: ErrorCodes.VALIDATION, reason: '工具参数不是合法 JSON' }
      } else {
        try {
          result = await this.opts.toolRuntime!.exec(ctx, sessionType, name, args)
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
        this.opts.toolRuntime?.requestApproval
      ) {
        const approvalId = await this.opts.toolRuntime
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
      await this.appendAudit(ctx, meta, 'tool_result', {
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
      if (
        (result.ok && result.suspend === true) ||
        (!result.ok && result.code === 'APPROVAL_PENDING')
      ) {
        suspended = true
      }
    }
    return { toolCalls, toolMessages, stalled, suspended }
  }

  /**
   * 收尾回合（步数用尽时）：只暴露"结项/沟通"工具 + 明确指令，
   * 保证任务状态上报与面向用户的完成总结不因工具预算耗尽而丢失。
   */
  private async runWrapUp(
    ctx: TurnContext,
    meta: SessionMeta,
    turnId: string,
    sessionType: string,
    convo: ChatMessage[],
    tools: ToolSchema[],
    calledTools: Set<string>,
  ): Promise<{ text: string; toolCalls: number }> {
    const closure = tools.filter((t) => CLOSURE_TOOLS.has(t.name))
    convo.push({ role: 'system', content: WRAPUP_PROMPT })
    const { stepText, stepReasoning, calls } = await this.streamStep(ctx, convo, turnId, closure)
    if (stepReasoning.trim()) await this.appendThought(ctx, meta, stepReasoning, turnId)
    let count = 0
    if (calls.size && this.opts.toolRuntime) {
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0])
      const r = await this.execToolCalls(
        ctx,
        meta,
        `${String(turnId)}-wrap`,
        ordered,
        sessionType,
        calledTools,
      )
      count = r.toolCalls.length
    }
    return { text: stepText.trim(), toolCalls: count }
  }

  /**
   * 回合末兜底提示（写入会话的**系统消息**，前端显示为居中系统说明）：
   * - 本回合干了活却没上报任务状态 → 提醒"完成后要 task_update(done, note=总结)"，
   *   避免任务永久卡在「进行中」、用户也拿不到完成总结；
   * - 本回合完全没有正文（模型空手停下）→ 明确告知用户"这轮没有总结"。
   *
   * 注意：任务状态用**回合结束时重新读取**的结果，不能用回合开始时的快照——
   * 角色常在回合中途才 task_claim，快照会漏掉这条进行中的任务（真实踩过的坑）。
   */
  private async remindUnreportedTask(
    ctx: TurnContext,
    meta: SessionMeta,
    turnId: string,
    activeTask: ActiveTask | null,
    pendingTasks: PendingTask[],
    calledTools: Set<string>,
    toolCallCount: number,
    replied: boolean,
    /** 因提问挂起（等待用户决策）→ 不催任务状态 */
    suspendedForUser = false,
  ): Promise<void> {
    if (toolCallCount === 0) return
    if (suspendedForUser) return
    const freshActive =
      (await this.opts.toolRuntime?.activeTask?.(ctx).catch(() => null)) ?? activeTask
    const freshPending =
      (await this.opts.toolRuntime?.pendingTasks?.(ctx).catch(() => null)) ?? pendingTasks
    const reported = calledTools.has('task_update')
    const notes: string[] = []
    if (!reported && freshActive) {
      notes.push(
        `【系统】任务 ${freshActive.id}「${freshActive.title}」仍为进行中。若本轮已完成，` +
          '请调用 task_update(state=done, note=一句话完成总结) 上报——平台会更新任务栏并通知委派人；' +
          '若仍在进行，可忽略本提示。',
      )
    }
    if (!reported && !calledTools.has('task_claim') && freshPending.length) {
      const first = freshPending[0]!
      notes.push(
        `【系统】任务栏上还有待你领取的任务 ${first.id}「${first.title}」。` +
          '如果你已经做完了这件事，请先 task_claim 领取，再 task_update(state=done, note=完成总结)。',
      )
    }
    if (!replied) {
      notes.push(
        '【系统】本轮只执行了工具、没有输出任何正文与总结。请补一条面向用户的完成总结' +
          '（做了什么、产出文件、验证结果、遗留），并在任务完成时用 task_update(state=done, note=总结) 上报。',
      )
    }
    if (!notes.length) return
    const evt = await this.opts.store.appendEvent(meta, {
      kind: 'message',
      role: 'user',
      sender: 'system',
      content: { text: notes.join('\n'), blocks: [] },
      payload: { turnId, system: true },
    })
    this.opts.bus.emitLogEvent(ctx.projectId, evt)
  }

  /** 思考事件落盘（先盘后推）；返回事件 seq。 */
  private async appendThought(
    ctx: TurnContext,
    meta: SessionMeta,    text: string,
    turnId: string,
  ): Promise<number> {
    const evt = await this.opts.store.appendEvent(meta, {
      kind: 'thought',
      role: 'agent',
      sender: ctx.member.instanceId,
      content: { text: cut(text.trim(), MAX_REASONING_CHARS, '\n…(思考过长已截断)'), blocks: [] },
      payload: { turnId },
    })
    this.opts.bus.emitLogEvent(ctx.projectId, evt)
    return evt.seq
  }

  /** 步骤正文落盘（多步回合中间步骤；先盘后推）；返回事件 seq。 */
  private async appendStepMessage(
    ctx: TurnContext,
    meta: SessionMeta,
    text: string,
    turnId: string,
  ): Promise<number> {
    const evt = await this.opts.store.appendEvent(meta, {
      kind: 'message',
      role: 'agent',
      sender: ctx.member.instanceId,
      content: { text, blocks: [] },
      model: ctx.member.model,
      payload: { turnId, step: true },
    })
    this.opts.bus.emitLogEvent(ctx.projectId, evt)
    return evt.seq
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

  /** 是否可执行甲模式分派：启用钩子 + user 会话 + 管理/产品角色（条件单点在 system-prompt）。 */
  private dispatchEligible(ctx: TurnContext, sessionType: string): boolean {
    return isDispatchEligible({
      taskDispatchEnabled: !!this.opts.taskDispatch,
      sessionType,
      roleTemplateId: ctx.member.roleTemplateId,
    })
  }

  private async nextTurn(projectId: string, sessionId: string): Promise<number> {
    const all = await this.opts.store.readWindow(projectId, sessionId, { limit: 100000 })
    let max = 0
    for (const e of all) if (typeof e.turn === 'number' && e.turn > max) max = e.turn
    return max + 1
  }

  private async buildHistory(ctx: TurnContext): Promise<ChatMessage[]> {
    const window = await this.opts.store.readTail(
      ctx.projectId,
      ctx.sessionId,
      this.opts.windowSize ?? 60,
    )
    // 会议/多角色场景：**别人的发言也要看到**（否则会议里互相听不见，主持人会说"没能读到成员发言"）
    const otherSpeakers = new Set(
      window
        .filter(
          (e) => e.kind === 'message' && e.role === 'agent' && e.sender !== ctx.member.instanceId,
        )
        .map((e) => String(e.sender)),
    )
    const names = new Map<string, string>()
    for (const m of ctx.assignableMembers ?? []) names.set(m.instanceId, m.displayName)
    const out: ChatMessage[] = []
    for (const e of window) {
      if (e.kind !== 'message') continue
      if (e.role === 'user' && e.content) {
        // 平台注入的系统消息（会议开场/邀请/唤醒）标注来源，避免被当成用户本人的话
        const system = e.payload?.system === true || e.sender === 'system'
        out.push({ role: 'user', content: system ? `【系统】${e.content.text}` : e.content.text })
      } else if (e.role === 'agent' && e.content) {
        if (e.sender === ctx.member.instanceId) {
          out.push({ role: 'assistant', content: e.content.text })
        } else if (otherSpeakers.has(String(e.sender))) {
          const who = names.get(String(e.sender)) ?? String(e.sender)
          out.push({
            role: 'user',
            content: `【${who}（${String(e.sender)}）发言】${e.content.text}`,
          })
        }
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
