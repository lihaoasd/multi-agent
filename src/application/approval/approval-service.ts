/**
 * 审批服务（approvals.jsonl，data-storage §7）。
 * 业务记录文件先原子写（事实生效），再向会话 log 追加投影（D18-⑤a）。
 * 用户决定只落盘不回放执行原动作（agent-runtime §7：跨重启不自动执行）。
 */
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'
import { approvalDecideError, type ApprovalStatus } from '../../domain/fsm/approval-state.js'
import type { SessionLogEvent } from '../../shared/types/session.js'

export interface ApprovalRecord {
  id: string
  kind: 'command' | 'submit' | 'rollback'
  actor: string
  projectId: string
  sessionId: string | null
  summary: string
  detail: string
  ruleId?: string
  status: ApprovalStatus
  requestedAt: string
  decidedAt: string | null
}

const FILE = 'approvals.jsonl'

export class ApprovalService {
  constructor(
    private readonly store: ProjectStore,
    private readonly appendLog: (
      projectId: string,
      sessionId: string,
      evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
    ) => Promise<SessionLogEvent>,
    private readonly onStateChange?: (projectId: string, record: ApprovalRecord) => void,
  ) {}

  private async readAll(projectId: string): Promise<ApprovalRecord[]> {
    return this.store.readAll<ApprovalRecord>(projectId, FILE)
  }

  async list(projectId: string, status?: string): Promise<ApprovalRecord[]> {
    const all = await this.readAll(projectId)
    const filtered = status ? all.filter((a) => a.status === status) : all
    return filtered.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
  }

  async get(projectId: string, approvalId: string): Promise<ApprovalRecord> {
    const rec = (await this.readAll(projectId)).find((a) => a.id === approvalId)
    if (!rec) throw new AppError(ErrorCodes.NOT_FOUND, `审批不存在: ${approvalId}`)
    return rec
  }

  /** 创建审批请求（业务记录先行）。sessionId 用于审计投影。 */
  async request(input: {
    projectId: string
    kind: ApprovalRecord['kind']
    actor: string
    sessionId?: string | null
    summary: string
    detail?: string
    ruleId?: string
  }): Promise<ApprovalRecord> {
    const rec: ApprovalRecord = {
      id: genId('ap_'),
      kind: input.kind,
      actor: input.actor,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      summary: input.summary,
      detail: input.detail ?? '',
      ruleId: input.ruleId,
      status: 'pending',
      requestedAt: nowIso(),
      decidedAt: null,
    }
    await this.append(rec)
    this.onStateChange?.(input.projectId, rec)
    return rec
  }

  /** 决定：批准/拒绝/过期。只落盘；调用方自行决定是否执行原动作。 */
  async decide(
    projectId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRecord> {
    const rec = await this.get(projectId, approvalId)
    // 判定规则在 domain/fsm/approval-state.ts（只有 pending 可被决定）
    const err = approvalDecideError(rec.status, approvalId)
    if (err) throw new AppError(ErrorCodes.CONFLICT, err)
    const next: ApprovalRecord = { ...rec, status: decision, decidedAt: nowIso() }
    await this.append(next)
    // 审计投影 → 会话 log
    if (rec.sessionId) {
      await this.appendLog(projectId, rec.sessionId, {
        kind: 'approval_result',
        role: 'system',
        sender: rec.actor,
        payload: { approvalId, decision, reason: reason ?? null, summary: rec.summary },
      }).catch(() => undefined)
    }
    this.onStateChange?.(projectId, next)
    return next
  }

  /** 作废该角色所有待批审批（2026-09-12）：pending → expired。
   *  用途同 question.cancelPending——角色被拉进会议前先放下"等待你处理"，
   *  否则会出现"审批待你处理、角色却已入会"的状态叠加。作废后不可再批准/拒绝。 */
  async expirePending(
    projectId: string,
    actor: string,
    reason: string,
  ): Promise<Array<{ id: string; summary: string }>> {
    const decidedAt = nowIso()
    const hit: ApprovalRecord[] = []
    await this.store.mutate<ApprovalRecord>(projectId, FILE, (all) => {
      const targets = all.filter((a) => a.actor === actor && a.status === 'pending')
      if (!targets.length) return null
      hit.push(...targets)
      const ids = new Set(targets.map((a) => a.id))
      return all.map((a) => (ids.has(a.id) ? { ...a, status: 'expired' as const, decidedAt } : a))
    })
    for (const a of hit) {
      if (a.sessionId) {
        await this.appendLog(projectId, a.sessionId, {
          kind: 'approval_result',
          role: 'system',
          sender: a.actor,
          payload: {
            approvalId: a.id,
            decision: 'expired',
            reason,
            summary: a.summary,
          },
        }).catch(() => undefined)
      }
      this.onStateChange?.(projectId, { ...a, status: 'expired', decidedAt })
    }
    return hit.map((a) => ({ id: a.id, summary: a.summary }))
  }

  /** 写入（pending 追加 / 决定重写同 id 行）。整表重写以保简单正确。 */
  private async append(rec: ApprovalRecord): Promise<void> {
    await this.store.mutate<ApprovalRecord>(rec.projectId, FILE, (all) => {
      const idx = all.findIndex((a) => a.id === rec.id)
      if (idx >= 0) all[idx] = rec
      else all.push(rec)
      return all
    })
  }
}
