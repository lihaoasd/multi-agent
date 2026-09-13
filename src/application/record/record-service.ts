/**
 * 项目全局记录（项目记录页 / 卡片流，2026-09-12）。
 *
 * 用户需求：任务完成、会议完成都要在**项目级**留下一条卡片记录，便于回溯"这个项目做过什么、结论是什么"。
 *
 * 本服务只是**读取投影**（不新增状态、不落盘）：把已有事实源合并成统一卡片，按时间倒序：
 *  - 任务终态（done / terminated）：标题 + 受派人 + 委派人 + **完成总结/终止说明**（`resultNote`）+ 时间；
 *  - 会议已结束（closed）：主题 + 描述 + 主持人 + 参会人 + 结束时间（纪要按需另行拉取）。
 *
 * 事实源仍是 tasks.jsonl 与会议会话 meta（单一真相，不重复存储）。
 */
import type { MeetingWithDisplay } from '../meeting/meeting-service.js'
import type { TaskService } from '../task/task-service.js'

export type ProjectRecordKind = 'meeting' | 'task'

export interface ProjectRecordCard {
  id: string
  kind: ProjectRecordKind
  title: string
  /** 任务=受派人；会议=主持人 */
  by: string
  at: string
  desc?: string
  /** 任务终态说明（完成总结 / 终止说明） */
  note?: string
  taskState?: string
  /** 会议呈现态：「进行中」/「已结束」（只有两态）；任务为「已完成」/「已终止」 */
  meetingState?: string
  /** 会议参会人（不含主持人） */
  members?: string[]
  /** 一键跳源：任务的执行会话 / 会议的会话 id */
  sessionId?: string
}

export class RecordService {
  constructor(
    private readonly tasks: TaskService,
    private readonly listMeetings: (projectId: string) => Promise<MeetingWithDisplay[]>,
  ) {}

  /** 项目记录卡片流（任务完成 + 会议，时间倒序）。 */
  async list(projectId: string): Promise<ProjectRecordCard[]> {
    const [tasks, meetings] = await Promise.all([
      this.tasks.list(projectId).catch(() => []),
      this.listMeetings(projectId).catch(() => []),
    ])

    const taskCards: ProjectRecordCard[] = tasks
      .filter((t) => t.state === 'done' || t.state === 'terminated')
      .map((t) => ({
        id: t.id,
        kind: 'task',
        title: t.title,
        by: t.assignee,
        at: t.updatedAt || t.ts,
        ...(t.desc ? { desc: t.desc } : {}),
        ...(t.resultNote?.trim() ? { note: t.resultNote.trim() } : {}),
        taskState: t.state,
        sessionId: t.sessionId,
      }))

    // 会议：**进行中与已结束都收录**（用户定稿：会议只有这两态，进行中的也在记录里可见）。
    // 被取消的会议不算记录（canceledAt 有值）。
    const meetingCards: ProjectRecordCard[] = meetings
      .filter((m) => !m.meeting.canceledAt)
      .map((m) => ({
        id: m.id,
        kind: 'meeting',
        title: m.meeting.topic || m.id,
        by: m.meeting.host,
        at: m.closedAt || m.updatedAt,
        ...(m.meeting.desc ? { desc: m.meeting.desc } : {}),
        meetingState: m.displayState,
        members: (m.participants?.agents ?? []).filter((a) => a !== m.meeting.host),
        sessionId: m.id,
      }))

    return [...taskCards, ...meetingCards].sort((a, b) => (a.at < b.at ? 1 : -1))
  }
}
