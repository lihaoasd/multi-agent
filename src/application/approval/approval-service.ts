/**
 * 审批服务（approvals.jsonl，data-storage §7）。
 * 业务记录文件先原子写（事实生效），再向会话 log 追加投影（D18-⑤a）。
 * 用户决定只落盘不回放执行原动作（agent-runtime §7：跨重启不自动执行）。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'
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
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  requestedAt: string
  decidedAt: string | null
}

export class ApprovalService {
  constructor(
    private readonly projectsRoot: string,
    private readonly appendLog: (
      projectId: string,
      sessionId: string,
      evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
    ) => Promise<SessionLogEvent>,
    private readonly onStateChange?: (projectId: string, record: ApprovalRecord) => void,
  ) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'approvals.jsonl')
  }

  private async readAll(projectId: string): Promise<ApprovalRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId), 'utf8')
    } catch {
      return []
    }
    const out: ApprovalRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as ApprovalRecord)
      } catch {
        // 坏行跳过
      }
    }
    return out
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
    if (rec.status !== 'pending') {
      throw new AppError(ErrorCodes.CONFLICT, `审批已处理（${rec.status}）: ${approvalId}`)
    }
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

  /** append 单条（pending 追加 / 决定重写同 id 行）。MVP：重写全表以保简单正确。 */
  private async append(rec: ApprovalRecord): Promise<void> {
    const all = await this.readAll(rec.projectId)
    const idx = all.findIndex((a) => a.id === rec.id)
    if (idx >= 0) all[idx] = rec
    else all.push(rec)
    const lines = all.map((a) => JSON.stringify(a)).join('\n') + '\n'
    await fs.mkdir(join(this.projectsRoot, rec.projectId), { recursive: true })
    await atomicWriteFile(this.file(rec.projectId), lines)
  }
}
