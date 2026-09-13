/**
 * 会议「邀请 / 报到」台账（meeting-invites.jsonl，2026-09-13）。
 *
 * 用户的会议流程：主持人发起 → 通知所有角色 → **主持人等全员入会** → 开场讨论。
 * 本台账就是"谁被邀请了、谁已报到"的唯一事实源（平台记录，不依赖模型自述）：
 *
 *  - `invited`：平台给某角色发了【会议邀请】（它下一步该停下手上工作、来开会）；
 *  - `joined` ：该角色已入会（占用转 meeting、落 meeting_event(action='join')）；
 *  - `left`   ：会议结束/取消，解除"未入会"闸门。
 *
 * 用途：
 *  1) loop 的 step 边界闸门 `hasPendingInvite()` —— 被邀请但还没入会 → 结束当前工作、去开会；
 *  2) 主持人的等待条件 `inMeeting()` —— 全员入会才开场。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'

export interface MeetingInviteRecord {
  projectId: string
  meetingId: string
  instanceId: string
  invitedAt: string
  joinedAt: string | null
  leftAt: string | null
}

export class MeetingInviteStore {
  constructor(private readonly projectsRoot: string) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'meeting-invites.jsonl')
  }

  private async readAll(projectId: string): Promise<MeetingInviteRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId), 'utf8')
    } catch {
      return []
    }
    const out: MeetingInviteRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as MeetingInviteRecord)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  private async writeAll(projectId: string, all: MeetingInviteRecord[]): Promise<void> {
    await fs.mkdir(join(this.projectsRoot, projectId), { recursive: true })
    await atomicWriteFile(this.file(projectId), all.map((x) => JSON.stringify(x)).join('\n') + '\n')
  }

  /** 发邀请（同会同人去重：已有未离会记录则不重复发）。 */
  async invite(
    projectId: string,
    meetingId: string,
    instanceId: string,
  ): Promise<MeetingInviteRecord> {
    const all = await this.readAll(projectId)
    const exist = all.find(
      (r) => r.meetingId === meetingId && r.instanceId === instanceId && !r.leftAt,
    )
    if (exist) return exist
    const rec: MeetingInviteRecord = {
      projectId,
      meetingId,
      instanceId,
      invitedAt: nowIso(),
      joinedAt: null,
      leftAt: null,
    }
    all.push(rec)
    await this.writeAll(projectId, all)
    return rec
  }

  /** 报到：记 joinedAt（平台在该角色被拉入会议时调用）。 */
  async markJoined(
    projectId: string,
    meetingId: string,
    instanceId: string,
  ): Promise<MeetingInviteRecord | null> {
    const all = await this.readAll(projectId)
    const rec = all.find((r) => r.meetingId === meetingId && r.instanceId === instanceId && !r.leftAt)
    if (!rec || rec.joinedAt) return rec ?? null
    rec.joinedAt = nowIso()
    await this.writeAll(projectId, all)
    return rec
  }

  /** 解除某个会议的邀请（散会/取消后，闸门不再拦住这些角色）。 */
  async markLeft(projectId: string, meetingId: string): Promise<void> {
    const all = await this.readAll(projectId)
    const at = nowIso()
    let touched = false
    for (const r of all) {
      if (r.meetingId === meetingId && !r.leftAt) {
        r.leftAt = at
        touched = true
      }
    }
    if (touched) await this.writeAll(projectId, all)
  }

  /** 该角色是否有**未入会**的会议邀请（loop step 边界闸门用）。 */
  async hasPendingInvite(projectId: string, instanceId: string): Promise<boolean> {
    return (await this.readAll(projectId)).some(
      (r) => r.instanceId === instanceId && !r.leftAt && !r.joinedAt,
    )
  }

  /** 某场会议里已报到的角色（主持人等待条件用）。 */
  async joinedOf(projectId: string, meetingId: string): Promise<string[]> {
    return (await this.readAll(projectId))
      .filter((r) => r.meetingId === meetingId && r.joinedAt && !r.leftAt)
      .map((r) => r.instanceId)
  }
}
