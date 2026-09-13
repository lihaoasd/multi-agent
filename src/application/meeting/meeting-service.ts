/**
 * 会议服务（M6 MVP，meetings.md 核心流）。
 * 状态：queued(排队) → proposed(征询占槽) → open ⇄ blocked_waiting_user → closed。
 * 约束：MVP 同时至多 1 个占槽会议（proposed/open/blocked），新发起 queued（D14-⑥/D16-①）；
 * 用户恒为成员；决策点至多 1 个 pending；纪要 = L1 可重放派生视图（D18-⑤b），close 时生成写参与者记忆。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../shared/util/id.js'
import type { SessionMeta, SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'
import { MemoryStore } from '../memory/memory-store.js'

/**
 * 把 domain 守卫结果包成 AppError（守卫通过时无操作）。
 * 规则与错误码/文案都在 `domain/fsm/meeting-state.ts`，本文件只负责"读 → 判 → 写"。
 */
function assertGuard(err: MeetingGuardError | null): void {
  if (err) throw new AppError(err.code as never, err.message)
}

/** 状态词汇与呈现规则已归位 domain（`domain/fsm/meeting-state.ts`）。 */
import {
  canAnswerDecision,
  canAskUser,
  canCancel,
  canClose,
  canMemberRespond,
  canSpeakTurn,
  canUserInterject,
  isOccupyingMeetingState,
  withMeetingDisplay,
  type MeetingGuardError,
  type WithDisplay,
} from '../../domain/fsm/meeting-state.js'
import { renderMeetingMinutes } from './minutes-renderer.js'

/**
 * 带呈现态的会议记录（REST 下发用）：state=内部子态，displayState=进行中/已结束。
 * 呈现规则本身在 domain（`withMeetingDisplay`）；此处只保留对外类型别名与薄委托，
 * 既有调用方（REST 路由、record-service）无需改动。
 */
export type MeetingWithDisplay = WithDisplay<MeetingRecord>

/** 给单条会议记录补上呈现态（进行中/已结束 + 是否排队等待）。 */
export function withDisplay(rec: MeetingRecord): MeetingWithDisplay {
  return withMeetingDisplay(rec)
}

export interface MeetingAgendaItem {
  title: string
  status: 'pending' | 'discussed' | 'concluded'
  conclusion?: string
}

export interface DecisionPoint {
  id: string
  question: string
  options: string[]
  status: 'pending' | 'answered'
  answer?: { choice?: string; text?: string }
  askedBy: string
  at: string
}

export interface MeetingRecord extends SessionMeta {
  type: 'meeting'
  meeting: {
    topic: string
    /** 会议描述（发起人填写：为什么开、期望产出） */
    desc?: string
    host: string
    agenda: MeetingAgendaItem[]
    members: string[]
    memberDecisions: Record<string, 'accept' | 'later' | 'decline'>
    decisionPoints: DecisionPoint[]
    minutesPending: boolean
    /**
     * 已入会成员（2026-09-13）：平台在角色被拉入会议时记录（不依赖模型自述）。
     * 主持人"等全员入会"的等待条件就查这里；queued 排队期间成员 accept 但尚未入会，故不写入。
     */
    memberJoined?: Record<string, { at: string }>
    closedAt?: string
    /** 取消时间（2026-09-12）：**取消不算"完成"**，项目记录只收录真正结束（close）的会议 */
    canceledAt?: string
  }
}

export interface CreateMeetingInput {
  projectId: string
  host: string
  topic: string
  /** 会议描述（可选，UI 发起时要求填写） */
  desc?: string
  agenda?: string[]
  members: string[]
}

export class MeetingService {
  constructor(
    private readonly store: SessionStore,
    private readonly memory: MemoryStore,
    private readonly onOpen?: (projectId: string, host: string, members: string[]) => Promise<void>,
    private readonly onClose?: (projectId: string, sessionId: string) => Promise<void>,
    private readonly runMemberTurn?: (
      projectId: string,
      meetingId: string,
      instanceId: string,
      prompt?: string,
    ) => Promise<void>,
    private readonly taskCreate?: (
      projectId: string,
      input: { title: string; desc: string; assignee: string; sessionId: string },
    ) => Promise<{ id: string }>,
    /**
     * 入会搁置（2026-09-12）：成员接受邀请时，把它"等待你处理"的提问/审批作废（见 question/approval service），
     * 否则会出现"卡片还在等用户、角色却已入会"的状态叠加。由组合根注入。
     */
    private readonly onShed?: (
      projectId: string,
      meetingId: string,
      instanceId: string,
    ) => Promise<void>,
    /**
     * 散会回注（2026-09-12）：会议关闭、纪要生成后，把「纪要 + 被搁置事项」回注各参会者并唤醒一轮，
     * 让它们带着会议结论继续推进任务（用户选择的"自动续跑"）。
     */
    private readonly onClosed?: (
      projectId: string,
      meetingId: string,
      minutes: string,
      participants: string[],
    ) => Promise<void>,
    /**
     * 排队会议被提升（2026-09-12）：槽位空出、queued → proposed 时触发。
     * 用于"等当前会议结束再自动开始"——由组合根接着跑该会议的讨论链（开场/发言/收尾）。
     */
    private readonly onPromoted?: (projectId: string, meeting: MeetingRecord) => Promise<void>,
    /**
     * 入会通知（2026-09-12）：成员接受邀请后，在**它自己的 user 会话**写一条系统消息，
     * 告知"你被拉进了哪场会、主题/描述是什么、本轮不用动手（等会议点名）"。
     * `opened` = 该会议是否已 open（false 表示还在排队等槽位）。
     */
    private readonly onInvited?: (
      projectId: string,
      meeting: MeetingRecord,
      member: string,
      /** 'invited' = 刚被邀请（会议已开始或在排队）；'started' = 排队的会议轮到、正式开始 */
      kind: 'invited' | 'started',
    ) => Promise<void>,
    /**
     * 报到（2026-09-13）：某成员**真正入会**（占用已置 meeting）时触发。
     * `allJoined=true` 表示受邀成员已全部报到 → 组合根据此唤醒主持人开场（主持人自己不轮询）。
     */
    private readonly onJoined?: (
      projectId: string,
      meetingId: string,
      member: string,
      allJoined: boolean,
    ) => Promise<void>,
  ) {}

  /**
   * 记录报到并返回是否全员到齐（主持人等待条件，2026-09-13）。
   * 主持人视为已到（它是发起方）；受邀成员看 `meeting.memberJoined`。
   */
  async markJoined(
    projectId: string,
    meetingId: string,
    instanceId: string,
  ): Promise<{ allJoined: boolean; joined: string[]; waiting: string[] }> {
    const rec = await this.get(projectId, meetingId)
    const joined = { ...(rec.meeting.memberJoined ?? {}) }
    if (!joined[instanceId]) joined[instanceId] = { at: nowIso() }
    rec.meeting.memberJoined = joined
    rec.updatedAt = nowIso()
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'join', member: instanceId },
    })
    const waiting = rec.meeting.members.filter((m) => !joined[m])
    return { allJoined: waiting.length === 0, joined: Object.keys(joined), waiting }
  }

  async list(projectId: string): Promise<MeetingRecord[]> {
    const ids = await this.store.listSessionIds(projectId)
    const out: MeetingRecord[] = []
    for (const sid of ids) {
      if (!sid.startsWith('m_')) continue
      const meta = await this.store.tryReadMeta(projectId, sid)
      if (meta?.type === 'meeting') out.push(meta as unknown as MeetingRecord)
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 会议槽位是否已被占用（proposed/open/blocked_waiting_user 都占槽，queued 不占）。 */
  async hasActiveMeeting(projectId: string): Promise<boolean> {
    return (await this.activeCount(projectId)) > 0
  }

  /**
   * 列表 + 呈现态（REST / UI 用）：`displayState` 只有「进行中/已结束」，
   * `waiting=true` 表示已发起但在排队等槽位（当前有别的会议在进行）。
   */
  async listForUi(projectId: string): Promise<MeetingWithDisplay[]> {
    return (await this.list(projectId)).map(withDisplay)
  }

  private async get(projectId: string, meetingId: string): Promise<MeetingRecord> {
    const meta = await this.store.tryReadMeta(projectId, meetingId)
    if (!meta || meta.type !== 'meeting') {
      throw new AppError(ErrorCodes.NOT_FOUND, `会议不存在: ${meetingId}`)
    }
    return meta as unknown as MeetingRecord
  }

  /** 占槽会议数（proposed/open/blocked_waiting_user 都占槽，queued 不占；判定规则在 domain）。 */
  private async activeCount(projectId: string): Promise<number> {
    const all = await this.list(projectId)
    return all.filter((m) => isOccupyingMeetingState(m.state as string)).length
  }

  /**
   * 槽位调度：无占槽会议时，把最早 queued 会议自动转 proposed（D16-① 槽空自动转 proposed）。
   * 供结束/取消后与新发起场景、启动自检调用，保证排队项不残留僵尸。
   */
  async promoteQueuedIfFree(projectId: string): Promise<void> {
    const occupied = (await this.activeCount(projectId)) > 0
    if (occupied) return
    const queued = (await this.list(projectId))
      .filter((m) => m.state === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const first = queued[0]
    if (!first) return
    const rec = await this.get(projectId, first.id)
    rec.state = 'proposed'
    rec.updatedAt = nowIso()
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'promote_queued' },
    })
    // 排队等待结束 → 真正开始：平台接着跑讨论链（主持人开场/成员发言/收尾）。
    // 发起人发起时是排队态、并没有开场过，所以这里才是它的"开始"。
    // **不 await**：链里有模型回合（秒级~分钟级），而本方法在 close()/cancel() 的调用栈里，
    // 阻塞它会让"结束会议"这个 HTTP 请求一直挂着（与 meeting_start 的后台链保持一致）。
    if (this.onPromoted) void this.onPromoted(projectId, rec).catch(() => undefined)
  }

  /** 阵容聚合消息（D14-⑤/D17-②）：成员决定汇总推给用户（谁在会/稍后/拒绝）。 */
  private async emitLineup(
    rec: MeetingRecord,
    trigger: 'accept' | 'later' | 'decline',
  ): Promise<void> {
    void trigger
    const d = rec.meeting.memberDecisions
    const lineup = {
      accepted: Object.entries(d)
        .filter(([, v]) => v === 'accept')
        .map(([m]) => m),
      later: Object.entries(d)
        .filter(([, v]) => v === 'later')
        .map(([m]) => m),
      declined: Object.entries(d)
        .filter(([, v]) => v === 'decline')
        .map(([m]) => m),
    }
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'lineup', ...lineup },
    })
  }

  /** 发起会议（meeting_start 落点）。 */
  async create(input: CreateMeetingInput): Promise<MeetingRecord> {
    if (!input.members.length) throw new AppError(ErrorCodes.VALIDATION, '成员至少 1 人')
    if (input.members.includes(input.host)) {
      throw new AppError(ErrorCodes.VALIDATION, '成员不应包含主持人')
    }
    const id = genId('m_')
    const ts = nowIso()
    const occupied = (await this.activeCount(input.projectId)) > 0
    const rec: MeetingRecord = {
      id,
      type: 'meeting',
      projectId: input.projectId,
      participants: { user: true, agents: [input.host, ...input.members] },
      host: input.host,
      state: occupied ? 'queued' : 'proposed',
      agenda: null,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      lastSeq: 0,
      segments: [],
      summaryRefs: [],
      meeting: {
        topic: input.topic,
        desc: input.desc?.trim() ?? '',
        host: input.host,
        agenda: (input.agenda ?? []).map((t) => ({ title: t, status: 'pending' as const })),
        members: [...input.members],
        memberDecisions: {},
        decisionPoints: [],
        minutesPending: false,
      },
    }
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'create', topic: input.topic, desc: rec.meeting.desc },
    })
    return rec
  }

  /**
   * 记一条"会议挂起/等待"事件（开场门用，2026-09-12）：
   * 主持人开场前若仍有受邀成员未就绪（未入会/仍有待处理事项），落到会议日志里可追溯。
   */
  async recordHold(projectId: string, meetingId: string, waiting: string[]): Promise<void> {
    const rec = await this.get(projectId, meetingId)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'hold', waiting },
    })
  }

  /** 成员回应邀请（接受/稍后/拒绝）。≥1 接受 → open。 */
  async respond(
    projectId: string,
    meetingId: string,
    member: string,
    decision: 'accept' | 'later' | 'decline',
  ): Promise<MeetingRecord> {
    const rec = await this.get(projectId, meetingId)
    // 可回应的状态（2026-09-12）：proposed / open / **queued**。
    // queued = 已有会议在进行、本场排队等待——受邀成员此时就该回应"我参加"，
    // 只是**不占会议槽**（占用等 open 时才给），否则排队会议永远没人接受、轮到后没人通知。
    const alreadyOpen = rec.state === 'open'
    const queued = rec.state === 'queued'
    assertGuard(
      canMemberRespond({
        state: rec.state,
        member,
        host: rec.meeting.host,
        members: rec.meeting.members,
        decided: Boolean(rec.meeting.memberDecisions[member]),
      }),
    )
    rec.meeting.memberDecisions[member] = decision
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'respond', member, decision },
    })
    // 接受入会 = 放下"等待你处理"（搁置提问/审批），避免卡片与"会议中"叠加；
    // 在占用（onOpen）之前完成，保证入会那一刻角色已经没有待处理项。
    if (decision === 'accept') {
      await this.onShed?.(projectId, rec.id, member).catch(() => undefined)
      // 入会通知（2026-09-12）：被邀请者此前**收不到任何"你要开会"的通知**——
      // 它只在会议会话被点名时才知道。这里在它自己的 user 会话写一条系统消息（不唤醒回合，
      // 避免它在会议还没开场时按自己的旧上下文开工）。
      if (this.onInvited) {
        void this.onInvited(projectId, rec, member, 'invited').catch(() => undefined)
      }
    }
    const accepts = Object.entries(rec.meeting.memberDecisions)
      .filter(([, d]) => d === 'accept')
      .map(([m]) => m)
    if (queued) {
      // 排队等待中：只记录"我参加"，**不占会议槽、不改 open、不入会占用**
      rec.updatedAt = nowIso()
      await this.store.writeMeta(rec)
      await this.emitLineup(rec, decision)
      return rec
    }
    if (decision === 'accept') {
      if (!alreadyOpen) {
        rec.state = 'open'
        rec.updatedAt = nowIso()
        await this.store.writeMeta(rec)
        await this.append(rec, {
          kind: 'meeting_event',
          role: 'system',
          payload: { action: 'open', members: accepts },
        })
      }
      // 阵容聚合消息（D17-②）：谁在会/稍后/拒绝 汇总成一条，不逐条打扰
      await this.emitLineup(rec, decision)
      // 已 open 时只为"新入会成员"补占用（onOpen 内部对主持人幂等）
      await this.onOpen?.(projectId, rec.meeting.host, alreadyOpen ? [member] : accepts)
      // 报到（2026-09-13）：该成员此刻**真正入会**（占用已置 meeting）→ 平台记录并落 join 事件。
      // 主持人"等全员入会"的等待条件由此推进；全员到齐时 onJoined 会回报 allJoined=true，
      // 由组合根注入系统消息唤醒主持人开场（主持人自己**不在回合里轮询**，避免单工队列死锁）。
      await this.markJoined(projectId, rec.id, member)
        .then(({ allJoined }) => this.onJoined?.(projectId, rec.id, member, allJoined))
        .catch(() => undefined)
    } else {
      rec.updatedAt = nowIso()
      await this.store.writeMeta(rec)
      await this.emitLineup(rec, decision)
    }
    return rec
  }

  /** 主持人请求用户拍板（meeting_ask_user；仅主持人；至多 1 pending）。 */
  async askUser(
    projectId: string,
    meetingId: string,
    asker: string,
    question: string,
    options: string[] = [],
  ): Promise<DecisionPoint> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(
      canAskUser({
        state: rec.state,
        asker,
        host: rec.meeting.host,
        hasPendingDecision: rec.meeting.decisionPoints.some((d) => d.status === 'pending'),
      }),
    )
    const dp: DecisionPoint = {
      id: genId('q_'),
      question,
      options,
      status: 'pending',
      askedBy: asker,
      at: nowIso(),
    }
    rec.meeting.decisionPoints.push(dp)
    rec.state = 'blocked_waiting_user'
    rec.updatedAt = nowIso()
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'ask_user', question, decisionPointId: dp.id },
    })
    return dp
  }

  /** 用户答复决策点 → open 继续。 */
  async answerDecision(
    projectId: string,
    meetingId: string,
    questionId: string,
    answer: { choice?: string; text?: string },
  ): Promise<MeetingRecord> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(canAnswerDecision(rec.state))
    const dp = rec.meeting.decisionPoints.find((d) => d.id === questionId && d.status === 'pending')
    if (!dp) throw new AppError(ErrorCodes.NOT_FOUND, `待答复决策点不存在: ${questionId}`)
    dp.status = 'answered'
    dp.answer = answer
    rec.state = 'open'
    rec.updatedAt = nowIso()
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'user',
      sender: 'user',
      payload: {
        action: 'user_answer',
        question: dp.question,
        answer: answer.text ?? answer.choice ?? '',
      },
    })
    return rec
  }

  /** 取消 queued/proposed 会议。 */
  async cancel(projectId: string, meetingId: string, actor: string): Promise<void> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(canCancel({ state: rec.state, actor, host: rec.meeting.host }))
    rec.state = 'closed'
    rec.closedAt = nowIso()
    // 取消 ≠ 完成：记 canceledAt，项目记录据此把"取消的会议"排除在完成记录之外
    rec.meeting.canceledAt = rec.closedAt
    rec.updatedAt = nowIso()
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'cancel', actor },
    })
    // 槽位空出：排队中的最早 queued 自动转 proposed（D16-①）
    await this.promoteQueuedIfFree(projectId)
  }

  /**
   * 主持人点名成员发言（会议轮次引擎 MVP，meetings.md §4）。
   * 仅 open 会议可点名（blocked 等用户拍板时不推进新轮）；成员必须是参会者。
   */
  async speakTurn(
    projectId: string,
    meetingId: string,
    host: string,
    member: string,
    question?: string,
  ): Promise<void> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(
      canSpeakTurn({
        state: rec.state,
        host: rec.meeting.host,
        caller: host,
        member,
        agents: rec.participants.agents,
      }),
    )
    const pending = rec.meeting.agenda.find((a) => a.status === 'pending')
    const prompt =
      question ??
      `【会议点名】你是成员 ${member}。请就当前议题「${pending?.title ?? rec.meeting.topic}」简明发表意见（结论+理由）。`
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'round', host, member, question: prompt.slice(0, 120) },
    })
    if (!this.runMemberTurn) {
      throw new AppError(ErrorCodes.INTERNAL, '成员回合执行器未注入')
    }
    await this.runMemberTurn(projectId, meetingId, member, prompt)
  }

  /** 用户插话（meetings.md §4：open 与 blocked 均可插话，不打断生成）。 */
  async userInterject(projectId: string, meetingId: string, text: string): Promise<void> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(canUserInterject(rec.state))
    const t = text.trim()
    if (!t) throw new AppError(ErrorCodes.VALIDATION, '内容不能为空')
    const evt = await this.append(rec, {
      kind: 'message',
      role: 'user',
      sender: 'user',
      content: { text: t, blocks: [] },
    })
    void evt
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'interject' },
    })
  }

  /** 纪要重新生成（D18-⑤b 可重放派生视图；UI「重新生成纪要」）。 */
  async regenerateMinutes(projectId: string, meetingId: string): Promise<{ text: string }> {
    const rec = await this.get(projectId, meetingId)
    if (rec.state !== 'closed') throw new AppError(ErrorCodes.CONFLICT, '会议未结束，无法生成纪要')
    await this.generateMinutes(projectId, meetingId)
    return { text: await this.renderMinutes(projectId, meetingId) }
  }

  /**
   * 纪要待办转出任务（D17-⑦ 一步化）：标题=待办摘要、受派者预填(可改)、
   * 来源自动挂本会议、creator=user；desc 附纪要正文。
   */
  async createTaskFromMinutes(
    projectId: string,
    meetingId: string,
    input: { title?: string; assignee: string },
  ): Promise<{ id: string; title: string }> {
    const rec = await this.get(projectId, meetingId)
    if (rec.state !== 'closed') throw new AppError(ErrorCodes.CONFLICT, '会议未结束，无法转出任务')
    if (!this.taskCreate) throw new AppError(ErrorCodes.INTERNAL, '任务创建器未注入')
    const minutes = await this.renderMinutes(projectId, meetingId)
    const title = (input.title?.trim() || `[纪要] ${rec.meeting.topic} 待办`).slice(0, 120)
    const task = await this.taskCreate(projectId, {
      title,
      desc: `来源会议 ${meetingId} 的纪要转出任务\n${minutes}`,
      assignee: input.assignee,
      sessionId: meetingId,
    })
    return { id: task.id, title }
  }

  /** 结束会议：置 minutesPending → 生成纪要（可重放派生视图）→ 回写记忆。 */
  async close(projectId: string, meetingId: string, actor: string): Promise<MeetingRecord> {
    const rec = await this.get(projectId, meetingId)
    assertGuard(canClose(rec.state))
    rec.state = 'closed'
    rec.closedAt = nowIso()
    rec.updatedAt = nowIso()
    rec.meeting.minutesPending = true
    await this.store.writeMeta(rec)
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'close', actor },
    })
    // 纪要生成（基于全量日志，幂等可重放）
    const minutes = await this.generateMinutes(projectId, meetingId)
    rec.meeting.minutesPending = false
    await this.store.writeMeta(rec)
    // 写参与者角色记忆 + 全局记忆（meeting_summary）
    const summaryId = `mem_${meetingId.replace(/[^a-z0-9]/g, '')}`
    for (const member of [...rec.participants.agents]) {
      await this.memory
        .append(
          projectId,
          {
            type: 'meeting_summary',
            content: minutes.text,
            source: { sessionId: meetingId, seq: null },
            tags: ['meeting'],
            refs: [meetingId],
          },
          'role',
          member,
        )
        .catch(() => undefined)
    }
    await this.memory
      .append(
        projectId,
        {
          type: 'meeting_summary',
          content: minutes.text,
          source: { sessionId: meetingId, seq: null },
          tags: ['meeting'],
          refs: [meetingId],
        },
        'global',
      )
      .catch(() => undefined)
    void summaryId
    await this.onClose?.(projectId, meetingId)
    // 散会回注（2026-09-12）：带着「纪要 + 入会时被搁置的提问/审批」把参会者唤醒，继续推进任务。
    // 放在 onClose（会议内发言/收尾）之后：回注内容基于最终纪要。
    await this.onClosed?.(projectId, meetingId, minutes.text, [
      ...new Set([rec.meeting.host, ...rec.participants.agents]),
    ]).catch(() => undefined)
    // 槽位空出：排队中的最早 queued 自动转 proposed（D16-①）
    await this.promoteQueuedIfFree(projectId)
    return rec
  }

  /** 读取纪要（重放派生视图：基于 closed 会话全量日志）。 */
  async getMinutes(
    projectId: string,
    meetingId: string,
  ): Promise<{ text: string; sessionId: string }> {
    const rec = await this.get(projectId, meetingId)
    if (rec.state !== 'closed') throw new AppError(ErrorCodes.CONFLICT, `会议未结束`)
    return { text: await this.renderMinutes(projectId, meetingId), sessionId: meetingId }
  }

  private async generateMinutes(projectId: string, meetingId: string): Promise<{ text: string }> {
    const text = await this.renderMinutes(projectId, meetingId)
    const rec = await this.get(projectId, meetingId)
    await this.append(rec, { kind: 'summary', role: 'system', payload: { minutes: text } })
    return { text }
  }

  private async renderMinutes(projectId: string, meetingId: string): Promise<string> {
    const rec = await this.get(projectId, meetingId)
    const events = await this.store.readWindow(projectId, meetingId, { limit: 100000 })
    // 纯渲染在 ./minutes-renderer.ts（规则式纪要，文案逐字一致）
    return renderMeetingMinutes(rec, events)
  }

  private async append(
    rec: MeetingRecord,
    evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
  ): Promise<void> {
    const meta = (await this.store.tryReadMeta(rec.projectId, rec.id)) as MeetingRecord | null
    await this.store.appendEvent(meta ?? rec, evt)
  }
}
