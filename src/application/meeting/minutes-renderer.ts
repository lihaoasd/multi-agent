/**
 * 会议纪要渲染（P3f 从 `MeetingService.renderMinutes` 抽出，2026-09-14）。
 *
 * 现状是**规则式纪要（MVP）**：取会议会话里最近 12 条 `meeting_event`，
 * 加上主持人/成员与用户决策点，拼成一段文本；末尾显式标注 "(规则式纪要 MVP，真实生成 M8)"
 * ——保留这句是为了不让人误以为这里有模型生成。
 *
 * 抽成纯函数：输入（会议记录 + 事件窗口）确定则输出确定，便于单独断言；
 * service 只负责"读窗口 → 调本函数 → 落盘"。
 */
import type { SessionLogEvent } from '../../shared/types/session.js'
import type { MeetingRecord } from './meeting-service.js'

/** 纪要里最多附几条过程事件（避免纪要变成整场流水）。 */
export const MINUTES_EVENT_TAIL = 12

/** 渲染规则式会议纪要（**文案与原实现逐字一致**）。 */
export function renderMeetingMinutes(rec: MeetingRecord, events: SessionLogEvent[]): string {
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
    ...lines.slice(-MINUTES_EVENT_TAIL),
    ...(answers.length ? ['用户决策:', ...answers] : []),
    '(规则式纪要 MVP，真实生成 M8)',
  ].join('\n')
}
