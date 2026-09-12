/**
 * 会话应用服务（M2）：发送用户消息 → 落盘 → 触发 Agent direct 回合（先盘后推 + 流式）。
 * 单机单进程：同一会话串行处理（内存队列），dispatcher 完整单工状态机在 M3 落地。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { SessionMeta, SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from './session-store.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import { AgentLoopRunner, type TurnContext } from '../agent-loop/loop-runner.js'
import type { SummaryEngine } from '../memory/summary-engine.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

export interface SendMessageResult {
  sessionId: string
  /** 用户消息已落盘 seq */
  seq: number
  /** true = 回合已在后台处理（异步推进，WS 推送） */
  queued: boolean
}

interface PendingTurn {
  promise: Promise<unknown>
}

export class SessionService {
  /** 每项目每实例占用的活动会话（单工 MVP 内存态；M3 落盘 occupancy） */
  private readonly pending: Map<string, PendingTurn> = new Map()

  constructor(
    private readonly store: SessionStore,
    private readonly bus: EventBus,
    private readonly loop: AgentLoopRunner,
    private readonly memberResolver: (
      projectId: string,
      instanceId: string,
    ) => Promise<TeamMemberConfig | null>,
    private readonly projectNameResolver: (projectId: string) => Promise<string>,
    private readonly summary?: SummaryEngine,
    private readonly teamLister?: (projectId: string) => Promise<TeamMemberConfig[]>,
  ) {}

  /** 每个角色回合都注入团队名册（谁在队伍里），pm/product 另外据此生成可派对象清单。 */
  private async fillAssignables(ctx: TurnContext, member: TeamMemberConfig): Promise<TurnContext> {
    if (!this.teamLister) return ctx
    const team = await this.teamLister(ctx.projectId).catch(() => [])
    ctx.assignableMembers = team
      .filter((m) => m.enabled)
      .map((m) => ({
        instanceId: m.instanceId,
        displayName: m.displayName,
        roleTemplateId: m.roleTemplateId,
      }))
    void member
    return ctx
  }

  /** 会话列表（附未读 unread = lastSeq - readSeq，MVP 单用户口径）。 */
  async listSessions(projectId: string): Promise<SessionMeta[]> {
    const ids = await this.store.listSessionIds(projectId)
    const out: SessionMeta[] = []
    for (const sid of ids) {
      const meta = await this.store.tryReadMeta(projectId, sid)
      if (meta) out.push(this.withUnread(meta))
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  /** 已读标记：记录用户读到的最大 seq（重连增量/未读依据，contract WS ack）。 */
  async markRead(projectId: string, sessionId: string, seq: number): Promise<SessionMeta> {
    const meta = await this.getSession(projectId, sessionId)
    const readSeq = (meta.readSeq as number | undefined) ?? 0
    if (seq <= readSeq) return this.withUnread(meta)
    const next = { ...meta, readSeq: seq, updatedAt: new Date().toISOString() }
    await this.store.writeMeta(next)
    return this.withUnread(next)
  }

  private withUnread(meta: SessionMeta): SessionMeta {
    const readSeq = (meta.readSeq as number | undefined) ?? 0
    const unread = Math.max(0, meta.lastSeq - readSeq)
    return { ...meta, readSeq, unread }
  }

  async getSession(projectId: string, sessionId: string): Promise<SessionMeta> {
    const meta = await this.store.tryReadMeta(projectId, sessionId)
    if (!meta) throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    if (meta.projectId !== projectId)
      throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    return this.withUnread(meta)
  }

  async getMessages(
    projectId: string,
    sessionId: string,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<SessionLogEvent[]> {
    await this.getSession(projectId, sessionId)
    return this.store.readWindow(projectId, sessionId, {
      fromSeq: opts.beforeSeq ? opts.beforeSeq - (opts.limit ?? 50) + 1 : undefined,
      limit: opts.limit ?? 50,
    })
  }

  /** 原始事件时间线（D14-④）：按 kind 过滤、fromSeq 起增量拉取（重连恢复）。 */
  async getRawLog(
    projectId: string,
    sessionId: string,
    opts: { fromSeq?: number; kind?: string } = {},
  ): Promise<SessionLogEvent[]> {
    await this.getSession(projectId, sessionId)
    const evts = await this.store.readWindow(projectId, sessionId, {
      fromSeq: opts.fromSeq,
      limit: 100000,
    })
    if (opts.kind) return evts.filter((e) => e.kind === opts.kind)
    return evts
  }

  /**
   * 用户发送消息：user 会话 → 校验实例存在/启用 → 落盘 message 事件 →
   * 若实例空闲则立即执行 direct 回合，否则串行排队（单会话 FIFO）。
   * `wake:false` = 只落盘不跑回合（用于"问题还没问完，先别让角色继续"的场景）。
   */
  async sendUserMessage(
    projectId: string,
    sessionId: string,
    text: string,
    opts: { system?: boolean; wake?: boolean } = {},
  ): Promise<SendMessageResult> {
    const trimmed = text?.trim()
    if (!trimmed) throw new AppError(ErrorCodes.VALIDATION, '消息内容不能为空')
    const meta = await this.getSession(projectId, sessionId)
    if (meta.type !== 'user') {
      throw new AppError(
        ErrorCodes.VALIDATION,
        '仅 user 会话可直接发送消息（meeting 会话走会议接口）',
      )
    }
    const instanceId = meta.participants.agents[0]!
    const member = await this.memberResolver(projectId, instanceId)
    if (!member) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${instanceId}`)
    if (!member.enabled) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `实例已停用，会话只读: ${instanceId}（重新启用后可继续）`,
      )
    }
    if (meta.state !== 'active') {
      throw new AppError(ErrorCodes.CONFLICT, `会话当前不可发送（state=${String(meta.state)}）`)
    }

    const userEvent = await this.store.appendEvent(meta, {
      kind: 'message',
      role: 'user',
      sender: opts.system ? 'system' : 'user',
      content: { text: trimmed, blocks: [] },
      ...(opts.system ? { payload: { system: true } } : {}),
    })
    this.bus.emitLogEvent(projectId, userEvent)

    // wake=false：只把消息落盘（例如"还有排队提问没问完"），等条件满足再唤醒
    if (opts.wake === false) return { sessionId, seq: userEvent.seq, queued: true }

    const baseCtx: TurnContext = {
      projectId,
      sessionId,
      member,
      scenario: await this.projectNameResolver(projectId).catch(() => '本项目'),
    }
    const turnCtx = await this.fillAssignables(baseCtx, member)
    const key = `${projectId}:${instanceId}`
    const prev = this.pending.get(key)
    const run = () =>
      this.loop.runDirectTurn(turnCtx).catch((e) => {
        // 回合失败不吞：记录并继续
        void e
      })
    // 串行：前一个回合结束后再跑本次（若前一个仍在执行则排队）
    const promise = prev ? prev.promise.then(run) : run()
    this.pending.set(key, { promise })
    void promise
      .then(async () => {
        if (this.summary) {
          const fresh = await this.store.tryReadMeta(projectId, sessionId)
          if (fresh) await this.summary.maybeSummarize(fresh)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key)
      })

    return { sessionId, seq: userEvent.seq, queued: true }
  }

  /** 等待某实例所有已排队回合完成（测试/调用方确认用）。 */
  async whenIdle(projectId: string, instanceId: string): Promise<void> {
    const p = this.pending.get(`${projectId}:${instanceId}`)
    if (p) await p.promise
  }

  /**
   * 在指定会话（user 或 meeting）为指定实例执行一轮（会议点名发言等）。
   * 调用方负责会话状态约束；复用同一实例的串行队列（单工）。
   */
  async runAgentTurn(
    projectId: string,
    sessionId: string,
    instanceId: string,
    opts: { prompt?: string } = {},
  ): Promise<void> {
    const meta = await this.store.tryReadMeta(projectId, sessionId)
    if (!meta) throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    if (!(meta.participants?.agents ?? []).includes(instanceId)) {
      throw new AppError(ErrorCodes.VALIDATION, `实例不在该会话参与者中: ${instanceId}`)
    }
    const member = await this.memberResolver(projectId, instanceId)
    if (!member) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${instanceId}`)

    const prompt = opts.prompt
    if (prompt) {
      // 平台注入的提示（会议开场/邀请/收尾）落盘为**系统消息**：
      // 仍以 role=user 进入模型历史，但 sender/payload 标记为 system，前端不会显示成"我的发言"
      const evt = await this.store.appendEvent(meta, {
        kind: 'message',
        role: 'user',
        sender: 'system',
        content: { text: prompt, blocks: [] },
        payload: { system: true },
      })
      this.bus.emitLogEvent(projectId, evt)
    }
    const baseCtx: TurnContext = {
      projectId,
      sessionId,
      member,
      scenario: await this.projectNameResolver(projectId).catch(() => '本项目'),
    }
    const turnCtx = await this.fillAssignables(baseCtx, member)
    await this.enqueue(projectId, instanceId, meta.id, () => this.loop.runDirectTurn(turnCtx))
  }

  /** 入队执行（同实例 FIFO）；完成后触发摘要。 */
  private async enqueue(
    projectId: string,
    instanceId: string,
    sessionId: string,
    job: () => Promise<SessionLogEvent>,
  ): Promise<void> {
    const key = `${projectId}:${instanceId}`
    const prev = this.pending.get(key)
    const promise = prev ? prev.promise.then(job) : job()
    this.pending.set(key, { promise })
    void promise
      .then(async () => {
        if (this.summary) {
          const fresh = await this.store.tryReadMeta(projectId, sessionId)
          if (fresh) await this.summary.maybeSummarize(fresh)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key)
      })
    await promise
  }
}
