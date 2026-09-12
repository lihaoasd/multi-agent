/**
 * 「需你处理」待办聚合（D17-③ 阻塞级三类之服务端汇总：会议拍板 / 高危命令与提交审批 / 角色提问）。
 * 供顶部待办条与 UI 角标使用；解除=对应原处操作后自动消失（不做第二份状态）。
 */
import { ApprovalService } from '../approval/approval-service.js'
import { MeetingService, type MeetingRecord } from '../meeting/meeting-service.js'
import type { QuestionService } from '../question/question-service.js'

export interface AttentionItem {
  kind: 'approval' | 'meeting' | 'question'
  id: string
  title: string
  detail: string
  sessionId: string | null
  at: string
  /** 原地操作引用：审批=approvalId；会议拍板=meetingId+questionId；提问=questionId */
  approvalId?: string
  meetingId?: string
  questionId?: string
}

const KIND_ZH: Record<string, string> = {
  confirm: '确认',
  single: '单选',
  multi: '多选',
  text: '文本',
}

export class AttentionService {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly meetings: MeetingService,
    private readonly questions?: QuestionService,
  ) {}

  async list(projectId: string): Promise<AttentionItem[]> {
    const out: AttentionItem[] = []
    const pending = await this.approvals.list(projectId, 'pending')
    for (const a of pending) {
      out.push({
        kind: 'approval',
        id: a.id,
        title: `审批：${a.summary}`,
        detail: `${a.actor} 发起的${a.kind}审批`,
        sessionId: a.sessionId,
        at: a.requestedAt,
        approvalId: a.id,
      })
    }
    const meetings = (await this.meetings.list(projectId)).filter(
      (m) => m.state === 'blocked_waiting_user' || m.state === 'open',
    )
    for (const m of meetings) {
      const dp = (m as unknown as MeetingRecord).meeting?.decisionPoints?.find(
        (d) => d.status === 'pending',
      )
      if (dp) {
        out.push({
          kind: 'meeting',
          id: dp.id,
          title: `会议拍板：${m.id} 「${dp.question.slice(0, 60)}」`,
          detail: `主持人 ${(m as unknown as MeetingRecord).meeting?.host} 请求你决定`,
          sessionId: m.id,
          at: dp.at,
          meetingId: m.id,
          questionId: dp.id,
        })
      }
    }
    if (this.questions) {
      const pendingQ = await this.questions.list(projectId, { status: 'pending' })
      for (const q of pendingQ) {
        // 问题列表（多题）：标题带上题数与第一题，详情列全部题干
        const first = q.items[0]
        const multi = q.items.length > 1
        out.push({
          kind: 'question',
          id: q.id,
          title: multi
            ? `${q.asker} 问你 ${q.items.length} 个问题：${(first?.question ?? '').slice(0, 50)}…`
            : `${q.asker} 问你：${(first?.question ?? q.question).slice(0, 60)}`,
          detail: multi
            ? q.items.map((it, i) => `${i + 1}. ${it.question}`).join('  ')
            : `需要你${KIND_ZH[(first?.kind ?? q.kind) as keyof typeof KIND_ZH] ?? first?.kind ?? q.kind}${
                first?.options.length ? `：${first.options.join(' / ')}` : ''
              }`,
          sessionId: q.sessionId,
          at: q.createdAt,
          questionId: q.id,
        })
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : 1))
  }
}
