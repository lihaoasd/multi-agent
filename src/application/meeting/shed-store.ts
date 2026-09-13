/**
 * 会议搁置清单（meeting-shed.jsonl，2026-09-12）。
 *
 * 角色被拉进会议时，它手头"等待你处理"的提问与待批审批会被**作废**（卡片消失、角色得以入会）。
 * 但那些事项不能凭空蒸发：散会后要把「会议结论 + 被作废的事项」回注给该角色，
 * 让它带着会议上下文继续推进任务。本文件就是这份"搁置清单"的落盘依据（纯文件、可重建）。
 *
 * 重构 P1（2026-09-14）：持久化改走 `ProjectStore` 门面（`infra/store`），本文件不再直接触碰 fs。
 */
import { genId, nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'

export interface ShedRecord {
  id: string
  projectId: string
  meetingId: string
  /** 被搁置的角色实例 id */
  instanceId: string
  at: string
  /** 被作废的待答提问（题干摘要） */
  questions: Array<{ id: string; question: string }>
  /** 被作废的待批审批（摘要） */
  approvals: Array<{ id: string; summary: string }>
}

const FILE = 'meeting-shed.jsonl'

export class MeetingShedStore {
  constructor(private readonly store: ProjectStore) {}

  private async readAll(projectId: string): Promise<ShedRecord[]> {
    return this.store.readAll<ShedRecord>(projectId, FILE)
  }

  /** 追加一条搁置记录（同一角色重复入会时保留多条，回注按会议取）。 */
  async append(input: {
    projectId: string
    meetingId: string
    instanceId: string
    questions: Array<{ id: string; question: string }>
    approvals: Array<{ id: string; summary: string }>
  }): Promise<ShedRecord | null> {
    if (!input.questions.length && !input.approvals.length) return null
    const rec: ShedRecord = {
      id: genId('shed_'),
      projectId: input.projectId,
      meetingId: input.meetingId,
      instanceId: input.instanceId,
      at: nowIso(),
      questions: input.questions,
      approvals: input.approvals,
    }
    await this.store.mutate<ShedRecord>(input.projectId, FILE, (all) => [...all, rec])
    return rec
  }

  /** 某场会议里被搁置的角色清单（散会后回注用）。 */
  async listByMeeting(projectId: string, meetingId: string): Promise<ShedRecord[]> {
    return (await this.readAll(projectId)).filter((r) => r.meetingId === meetingId)
  }
}
