/**
 * Agent 回合执行（M2：direct 单轮直答；M3 扩展 reflective/plan-execute 与工具链）。
 * 回合事件序列：turn_start → (流式 chunk/thought.chunk 推送，不入 log) →
 * thought(推理，有则落盘) → [task 分派 tool_call/tool_result(审计)] → message 整体落盘(message.commit) → turn_end。
 * 先盘后推（memory.md §2）：message 与全部审计事件先写 log 再广播。
 * think 展示（2026-09-09）：模型 reasoning 增量经 thought.chunk 推前端，流结束合并为 thought 事件落盘。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'
import { ModelGateway } from '../../infra/model/gateway.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import type { OccupancyStore } from '../dispatcher/occupancy-store.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

export interface TurnContext {
  projectId: string
  sessionId: string
  member: TeamMemberConfig
  /** 项目名/场景设定 */
  scenario: string
  /** 可指派对象（分派提示用；由上层按项目团队注入） */
  assignableMembers?: Array<{ instanceId: string; displayName: string }>
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
}

/** 思考/推理文本落盘上限（超长截断，防 log 膨胀） */
const MAX_REASONING_CHARS = 20000
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

    const system = this.buildSystemPrompt(ctx, meta.type)
    const history = await this.buildHistory(ctx)
    await store.appendEvent(meta, {
      kind: 'turn_start',
      sender: ctx.member.instanceId,
      payload: { turnId: `${ctx.sessionId}:${turn}`, loopStep: 'act' },
    })
    // plan-execute：回合开始即落计划/进度事件（data-storage §4.2 断点恢复依据；
    // MVP Mock 单段执行，stepIndex 0）
    if ((ctx.member.loop?.strategy ?? 'direct') === 'plan-execute') {
      const planEvent = await store.appendEvent(meta, {
        kind: 'plan',
        sender: ctx.member.instanceId,
        payload: {
          turnId: `${ctx.sessionId}:${turn}`,
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

    const messages = [{ role: 'system' as const, content: system }, ...history]
    let text = ''
    let reasoning = ''
    try {
      for await (const item of this.opts.gateway.streamChat({
        providerId: ctx.member.model,
        messages,
      })) {
        // 正文：message.chunk 推前端（临时态），流结束整体落盘
        if (item.content) {
          text += item.content
          this.opts.bus.emitChunk(ctx.projectId, ctx.sessionId, {
            turnId: `${ctx.sessionId}:${turn}`,
            delta: item.content,
            sender: ctx.member.instanceId,
          })
        }
        // 思考：thought.chunk 推前端（临时态），有值则流结束落盘 thought 事件
        if (item.reasoning) {
          reasoning += item.reasoning
          this.opts.bus.emitThoughtChunk(ctx.projectId, ctx.sessionId, {
            turnId: `${ctx.sessionId}:${turn}`,
            delta: item.reasoning,
            sender: ctx.member.instanceId,
          })
        }
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
      text = `（模型调用失败：${err instanceof Error ? err.message : err}）`
    }

    // 甲模式任务分派（pm/product 的 user 会话）：解析模型文本中的分派指令并执行；
    // 结果以平台说明追加进最终消息（诚实反馈登记/开工/排队/失败）。失败不影响回合。
    let dispatchNote = ''
    if (this.dispatchEligible(ctx, meta.type)) {
      dispatchNote = await this.opts.taskDispatch!
        .run(ctx, text)
        .catch((e: unknown) => `\n\n【系统】任务分派处理失败：${String(e instanceof Error ? e.message : e)}`)
    }
    const finalText = text + dispatchNote

    // 思考事件落盘（先于 message，语义上思考先于正文）
    const thoughtText = reasoning.trim()
    if (thoughtText) {
      const truncated =
        thoughtText.length > MAX_REASONING_CHARS
          ? thoughtText.slice(0, MAX_REASONING_CHARS) + '\n…(思考过长已截断)'
          : thoughtText
      const thoughtEvent = await store.appendEvent(meta, {
        kind: 'thought',
        role: 'agent',
        sender: ctx.member.instanceId,
        content: { text: truncated, blocks: [] },
        payload: { turnId: `${ctx.sessionId}:${turn}` },
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
      payload: { turnId: `${ctx.sessionId}:${turn}` },
    })
    // 先盘后推：commit 在 message 事件广播后
    this.opts.bus.emitLogEvent(ctx.projectId, msgEvent)
    this.opts.bus.emitCommit(ctx.projectId, ctx.sessionId, {
      seq: msgEvent.seq,
      turnId: `${ctx.sessionId}:${turn}`,
    })

    await store.appendEvent(meta, {
      kind: 'turn_end',
      sender: ctx.member.instanceId,
      payload: { turnId: `${ctx.sessionId}:${turn}`, ok: true },
    })
    return msgEvent
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

  private buildSystemPrompt(ctx: TurnContext, sessionType: string): string {
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

  private async buildHistory(
    ctx: TurnContext,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const window = await this.opts.store.readTail(
      ctx.projectId,
      ctx.sessionId,
      this.opts.windowSize ?? 60,
    )
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
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
