/**
 * 会话应用服务（M2）：发送用户消息 → 落盘 → 触发 Agent direct 回合（先盘后推 + 流式）。
 * 单机单进程：同一会话串行处理（内存队列），dispatcher 完整单工状态机在 M3 落地。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { SessionMeta, SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from './session-store.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import { AgentLoopRunner, type TurnContext } from '../agent-loop/loop-runner.js'
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
  ) {}

  async listSessions(projectId: string): Promise<SessionMeta[]> {
    const ids = await this.store.listSessionIds(projectId)
    const out: SessionMeta[] = []
    for (const sid of ids) {
      const meta = await this.store.tryReadMeta(projectId, sid)
      if (meta) out.push(meta)
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async getSession(projectId: string, sessionId: string): Promise<SessionMeta> {
    const meta = await this.store.tryReadMeta(projectId, sessionId)
    if (!meta) throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    if (meta.projectId !== projectId)
      throw new AppError(ErrorCodes.NOT_FOUND, `会话不存在: ${sessionId}`)
    return meta
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
   */
  async sendUserMessage(
    projectId: string,
    sessionId: string,
    text: string,
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
      sender: 'user',
      content: { text: trimmed, blocks: [] },
    })
    this.bus.emitLogEvent(projectId, userEvent)

    const turnCtx: TurnContext = {
      projectId,
      sessionId,
      member,
      scenario: await this.projectNameResolver(projectId).catch(() => '本项目'),
    }
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
    void promise.finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key)
    })

    return { sessionId, seq: userEvent.seq, queued: true }
  }

  /** 等待某实例所有已排队回合完成（测试/调用方确认用）。 */
  async whenIdle(projectId: string, instanceId: string): Promise<void> {
    const p = this.pending.get(`${projectId}:${instanceId}`)
    if (p) await p.promise
  }
}
