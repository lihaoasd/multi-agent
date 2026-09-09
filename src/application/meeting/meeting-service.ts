/**
 * 会议服务（M6 MVP，meetings.md 核心流）。
 * 状态：queued(排队) → proposed(征询占槽) → open ⇄ blocked_waiting_user → closed。
 * 约束：MVP 同时至多 1 个占槽会议（proposed/open/blocked），新发起 queued（D14-⑥/D16-①）；
 * 用户恒为成员；决策点至多 1 个 pending；纪要 = L1 可重放派生视图（D18-⑤b），close 时生成写参与者记忆。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import type { SessionMeta, SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'
import { MemoryStore } from '../memory/memory-store.js'

export type MeetingState = 'queued' | 'proposed' | 'open' | 'blocked_waiting_user' | 'closed'

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
    host: string
    agenda: MeetingAgendaItem[]
    members: string[]
    memberDecisions: Record<string, 'accept' | 'later' | 'decline'>
    decisionPoints: DecisionPoint[]
    minutesPending: boolean
    closedAt?: string
  }
}

export interface CreateMeetingInput {
  projectId: string
  host: string
  topic: string
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
  ) {}

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

  private async get(projectId: string, meetingId: string): Promise<MeetingRecord> {
    const meta = await this.store.tryReadMeta(projectId, meetingId)
    if (!meta || meta.type !== 'meeting') {
      throw new AppError(ErrorCodes.NOT_FOUND, `会议不存在: ${meetingId}`)
    }
    return meta as unknown as MeetingRecord
  }

  private async activeCount(projectId: string): Promise<number> {
    const all = await this.list(projectId)
    return all.filter((m) =>
      ['proposed', 'open', 'blocked_waiting_user'].includes(m.state as string),
    ).length
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
      payload: { action: 'create', topic: input.topic },
    })
    return rec
  }

  /** 成员回应邀请（接受/稍后/拒绝）。≥1 接受 → open。 */
  async respond(
    projectId: string,
    meetingId: string,
    member: string,
    decision: 'accept' | 'later' | 'decline',
  ): Promise<MeetingRecord> {
    const rec = await this.get(projectId, meetingId)
    if (rec.state !== 'proposed') {
      throw new AppError(ErrorCodes.CONFLICT, `仅 proposed 会议可回应邀请（当前 ${rec.state}）`)
    }
    if (!rec.meeting.members.includes(member) && member !== rec.meeting.host) {
      throw new AppError(ErrorCodes.VALIDATION, `成员不在本会议: ${member}`)
    }
    if (rec.meeting.memberDecisions[member]) {
      throw new AppError(ErrorCodes.CONFLICT, `成员已回应: ${member}`)
    }
    rec.meeting.memberDecisions[member] = decision
    await this.append(rec, {
      kind: 'meeting_event',
      role: 'system',
      payload: { action: 'respond', member, decision },
    })
    const accepts = Object.entries(rec.meeting.memberDecisions)
      .filter(([, d]) => d === 'accept')
      .map(([m]) => m)
    if (decision === 'accept') {
      rec.state = 'open'
      rec.updatedAt = nowIso()
      await this.store.writeMeta(rec)
      await this.append(rec, {
        kind: 'meeting_event',
        role: 'system',
        payload: { action: 'open', members: accepts },
      })
      // 阵容聚合消息（D17-②）：谁在会/稍后/拒绝 汇总成一条，不逐条打扰
      await this.emitLineup(rec, decision)
      await this.onOpen?.(projectId, rec.meeting.host, accepts)
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
    if (asker !== rec.meeting.host)
      throw new AppError(ErrorCodes.FORBIDDEN_PATH, '仅主持人可请求用户拍板')
    if (rec.state !== 'open')
      throw new AppError(ErrorCodes.CONFLICT, `仅 open 会议可发起决策点（当前 ${rec.state}）`)
    const pending = rec.meeting.decisionPoints.find((d) => d.status === 'pending')
    if (pending) throw new AppError(ErrorCodes.CONFLICT, '已有待答复决策点，先答复再发起下一个')
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
    if (rec.state !== 'blocked_waiting_user') {
      throw new AppError(ErrorCodes.CONFLICT, `当前非阻塞等待状态: ${rec.state}`)
    }
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
    if (!['queued', 'proposed'].includes(rec.state as string)) {
      throw new AppError(ErrorCodes.CONFLICT, `仅 queued/proposed 可取消（当前 ${rec.state}）`)
    }
    if (actor !== 'user' && actor !== rec.meeting.host) {
      throw new AppError(ErrorCodes.FORBIDDEN_PATH, '仅发起者或用户可取消')
    }
    rec.state = 'closed'
    rec.closedAt = nowIso()
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
    if (host !== rec.meeting.host)
      throw new AppError(ErrorCodes.FORBIDDEN_PATH, '仅主持人可点名发言')
    if (rec.state !== 'open') {
      throw new AppError(ErrorCodes.CONFLICT, `仅 open 会议可推进轮次（当前 ${rec.state}）`)
    }
    const isMember = rec.participants.agents.includes(member) && member !== rec.meeting.host
    if (!isMember) throw new AppError(ErrorCodes.VALIDATION, `非参会成员或为主持人: ${member}`)
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
    if (!['open', 'blocked_waiting_user'].includes(rec.state as string)) {
      throw new AppError(ErrorCodes.CONFLICT, `会议未进行（当前 ${rec.state}）`)
    }
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
    if (!['open', 'blocked_waiting_user'].includes(rec.state as string)) {
      throw new AppError(ErrorCodes.CONFLICT, `仅 open/blocked 会议可结束（当前 ${rec.state}）`)
    }
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
    const lines = events
      .filter((e) => e.kind === 'meeting_event')
      .map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>
        return `${p.action ?? e.kind}: ${JSON.stringify(p).slice(0, 160)}`
      })
    const answers = rec.meeting.decisionPoints
      .filter((d) => d.status === 'answered')
      .map((d) => `决策「${d.question}」→ ${d.answer?.text ?? d.answer?.choice ?? '(答复)'}`)
    return [
      `会议纪要：${rec.meeting.topic}`,
      `主持人: ${rec.meeting.host}；成员: ${rec.meeting.members.join(', ')}`,
      ...lines.slice(-12),
      ...(answers.length ? ['用户决策:', ...answers] : []),
      '(规则式纪要 MVP，真实生成 M8)',
    ].join('\n')
  }

  private async append(
    rec: MeetingRecord,
    evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
  ): Promise<void> {
    const meta = (await this.store.tryReadMeta(rec.projectId, rec.id)) as MeetingRecord | null
    await this.store.appendEvent(meta ?? rec, evt)
  }
}
