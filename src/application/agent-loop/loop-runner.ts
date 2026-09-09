/**
 * Agent 回合执行（M2：direct 单轮直答；M3 扩展 reflective/plan-execute 与工具链）。
 * 回合事件序列：turn_start → (流式 chunk 推送，不入 log) → message 整体落盘(message.commit) → turn_end。
 * 先盘后推（memory.md §2）：message 与全部审计事件先写 log 再广播。
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
}

export interface AgentLoopRunnerOptions {
  store: SessionStore
  gateway: ModelGateway
  bus: EventBus
  occupancy?: OccupancyStore
  /** 每回合 window 注入的消息上限（config.context.session.rawWindow） */
  windowSize?: number
}

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

    const system = this.buildSystemPrompt(ctx)
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
    try {
      for await (const chunk of this.opts.gateway.streamChat({
        providerId: ctx.member.model,
        messages,
      })) {
        text += chunk
        this.opts.bus.emitChunk(ctx.projectId, ctx.sessionId, {
          turnId: `${ctx.sessionId}:${turn}`,
          delta: chunk,
        })
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

    // 完整消息落盘（一条 message 事件，D14-⑦ 流式文本整体落盘）
    const msgEvent = await store.appendEvent(meta, {
      kind: 'message',
      role: 'agent',
      sender: ctx.member.instanceId,
      content: { text, blocks: [] },
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

  private async nextTurn(projectId: string, sessionId: string): Promise<number> {
    const all = await this.opts.store.readWindow(projectId, sessionId, { limit: 100000 })
    let max = 0
    for (const e of all) if (typeof e.turn === 'number' && e.turn > max) max = e.turn
    return max + 1
  }

  private buildSystemPrompt(ctx: TurnContext): string {
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
    return parts.join('\n')
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
