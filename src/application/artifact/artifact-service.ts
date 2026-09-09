/**
 * 产出物服务（M4：静态产物路径，workspaces-artifacts.md §2.1/§3；data-storage §6）。
 * 提交=把定稿（ws:// 私有区或 workdir 就地文件）拷入 workdir + 快照到 artifact-versions + manifest 落盘；
 * 回退=按前序版本快照恢复（内容依据=versionDir，H2，不依赖 git）。
 * doc 门（docSubmitApproval=true）→ 先落 submitted+审批（detail 存文件清单+首文件预览），approved 后 finalize 写入。
 */
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile, ensureInside } from '../../infra/file-store/fs-utils.js'
import { resolveVirtual } from '../../domain/rules/path-resolver.js'
import { ApprovalService } from '../approval/approval-service.js'
import type { SessionLogEvent } from '../../shared/types/session.js'

export const ARTIFACT_TYPES = ['doc', 'code', 'config', 'test', 'deploy'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export interface ArtifactFileEntry {
  relPath: string
  fromWsRel?: string
  action: 'add' | 'modify'
  hash: string
  size: number
}

export interface ArtifactRecord {
  id: string
  type: ArtifactType
  title: string
  summary: string
  submitter: string
  projectId: string
  sessionId: string | null
  taskId: string | null
  state: 'submitted' | 'approved' | 'rejected' | 'reverted'
  version: number
  files: ArtifactFileEntry[]
  diffSummary: { add: number; del: number }
  prevVersion: number | null
  approvalId: string | null
  versionDir: string
  ts: string
}

export interface SubmitFile {
  relPath: string
  fromWsRel?: string
}

export interface SubmitInput {
  projectId: string
  actor: string
  sessionId?: string
  taskId?: string | null
  type: ArtifactType
  title: string
  summary?: string
  files: SubmitFile[]
  needsApproval: boolean
}

interface Ctx {
  workdirRoot: string
  wsRoot: string
  runtimeRoot: string
}

export class ArtifactService {
  constructor(
    private readonly projectsRoot: string,
    private readonly approvals: ApprovalService,
    private readonly appendLog: (
      projectId: string,
      sessionId: string,
      evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
    ) => Promise<SessionLogEvent>,
  ) {}

  private manifestFile(projectId: string): string {
    return join(this.projectsRoot, projectId, 'artifacts.jsonl')
  }

  async readAll(projectId: string): Promise<ArtifactRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.manifestFile(projectId), 'utf8')
    } catch {
      return []
    }
    const out: ArtifactRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as ArtifactRecord)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  async list(projectId: string): Promise<ArtifactRecord[]> {
    return (await this.readAll(projectId)).sort((a, b) => (a.ts < b.ts ? 1 : -1))
  }

  async get(projectId: string, artifactId: string): Promise<ArtifactRecord> {
    const rec = (await this.readAll(projectId)).find((a) => a.id === artifactId)
    if (!rec) throw new AppError(ErrorCodes.NOT_FOUND, `产出物不存在: ${artifactId}`)
    return rec
  }

  /** 由项目 runtime 目录组装提交上下文（读 project.json 的 workdir）。 */
  private async ctxOf(projectId: string, actor: string): Promise<Ctx> {
    const proj = await readFile(join(this.projectsRoot, projectId, 'project.json'), 'utf8').then(
      (s) => JSON.parse(s) as { workdir: string },
    )
    return {
      workdirRoot: proj.workdir,
      wsRoot: join(this.projectsRoot, projectId, 'workspaces', actor),
      runtimeRoot: join(this.projectsRoot, projectId),
    }
  }

  private resolveSource(f: SubmitFile, ctx: Ctx): string {
    if (f.fromWsRel) {
      return resolveVirtual(f.fromWsRel, {
        wsRoot: ctx.wsRoot,
        workdirRoot: ctx.workdirRoot,
        roRoots: [],
        runtimeRoot: ctx.runtimeRoot,
      }).absolute
    }
    return ensureInside(ctx.workdirRoot, join(ctx.workdirRoot, f.relPath))
  }

  async submit(input: SubmitInput): Promise<{ record: ArtifactRecord; approvalId: string | null }> {
    if (!ARTIFACT_TYPES.includes(input.type)) {
      throw new AppError(ErrorCodes.VALIDATION, `不支持的产出物类型: ${input.type}`)
    }
    if (input.files.length === 0) throw new AppError(ErrorCodes.VALIDATION, 'files 不能为空')
    const ctx = await this.ctxOf(input.projectId, input.actor)
    for (const f of input.files) {
      await readFile(this.resolveSource(f, ctx)).catch(() => {
        throw new AppError(ErrorCodes.NOT_FOUND, `源文件不存在: ${f.fromWsRel ?? f.relPath}`)
      })
    }

    const id = genId('a_')
    const prev = (await this.readAll(input.projectId))
      .filter((a) => a.submitter === input.actor && a.type === input.type && a.state !== 'reverted')
      .sort((a, b) => b.version - a.version)[0]
    const version = (prev?.version ?? 0) + 1
    const record: ArtifactRecord = {
      id,
      type: input.type,
      title: input.title,
      summary: input.summary ?? '',
      submitter: input.actor,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      state: input.needsApproval ? 'submitted' : 'approved',
      version,
      files: [],
      diffSummary: { add: 0, del: 0 },
      prevVersion: prev?.version ?? null,
      approvalId: null,
      versionDir: `artifact-versions/${id}/v${version}`,
      ts: nowIso(),
    }

    if (input.needsApproval) {
      // 只读预览（D16-⑥）：首文件前 4000 字符
      const preview = await readFile(this.resolveSource(input.files[0]!, ctx), 'utf8')
        .then((s) => s.slice(0, 4000))
        .catch(() => '(无法预览：非文本或不存在)')
      const approval = await this.approvals.request({
        projectId: input.projectId,
        kind: 'submit',
        actor: input.actor,
        sessionId: input.sessionId,
        summary: `提交产出物: ${input.type}/${input.title} (${input.files.length} 文件, v${version})`,
        detail: JSON.stringify({ artifactId: id, files: input.files, preview }),
      })
      record.approvalId = approval.id
      await this.saveManifest(record)
      return { record, approvalId: approval.id }
    }

    await this.execute(record, input.files, ctx)
    await this.saveManifest(record)
    await this.appendLog(input.projectId, input.sessionId ?? `u_${input.actor}`, {
      kind: 'artifact',
      role: 'system',
      sender: input.actor,
      payload: { artifactId: id, action: 'submit', version },
    }).catch(() => undefined)
    return { record, approvalId: null }
  }

  /** 审批通过后执行（finalize）：拷贝+快照+明细，置 approved。 */
  async finalizeApproved(projectId: string, approvalId: string): Promise<ArtifactRecord | null> {
    const approval = await this.approvals.get(projectId, approvalId)
    if (approval.status !== 'approved') {
      throw new AppError(ErrorCodes.CONFLICT, `审批未通过: ${approval.status}`)
    }
    const detail = JSON.parse(approval.detail) as {
      artifactId: string
      files: SubmitFile[]
    }
    const rec = await this.get(projectId, detail.artifactId)
    if (rec.state !== 'submitted') return rec
    const ctx = await this.ctxOf(projectId, rec.submitter)
    await this.execute(rec, detail.files, ctx)
    rec.state = 'approved'
    await this.saveManifest(rec)
    await this.appendLog(projectId, rec.sessionId ?? `u_${rec.submitter}`, {
      kind: 'artifact',
      role: 'system',
      sender: rec.submitter,
      payload: { artifactId: rec.id, action: 'submit-approved', version: rec.version },
    }).catch(() => undefined)
    return rec
  }

  /** 拷贝到 workdir + 快照到 versionDir + 计算明细。 */
  private async execute(rec: ArtifactRecord, files: SubmitFile[], ctx: Ctx): Promise<void> {
    const vdir = join(this.projectsRoot, rec.projectId, rec.versionDir)
    await mkdir(vdir, { recursive: true })
    const entries: ArtifactFileEntry[] = []
    let add = 0
    for (const f of files) {
      const src = this.resolveSource(f, ctx)
      const dest = ensureInside(ctx.workdirRoot, join(ctx.workdirRoot, f.relPath), 'relPath')
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(src, dest)
      const snap = ensureInside(vdir, join(vdir, f.relPath))
      await mkdir(dirname(snap), { recursive: true })
      await copyFile(src, snap)
      const content = await readFile(src)
      entries.push({
        relPath: f.relPath,
        fromWsRel: f.fromWsRel,
        action: 'add',
        hash: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      })
      add += content.length
    }
    rec.files = entries
    rec.diffSummary = { add, del: 0 }
  }

  /** 回退：按目标版本快照恢复 workdir；记录置 reverted（不物理删历史）。 */
  async rollback(
    projectId: string,
    artifactId: string,
    toVersion?: number,
  ): Promise<ArtifactRecord> {
    const rec = await this.get(projectId, artifactId)
    const target = toVersion ?? Math.max(1, rec.version - 1)
    const ctx = await this.ctxOf(projectId, rec.submitter)
    for (const f of rec.files) {
      const snap = join(
        this.projectsRoot,
        projectId,
        'artifact-versions',
        artifactId,
        `v${target}`,
        f.relPath,
      )
      try {
        await readFile(snap)
      } catch {
        throw new AppError(ErrorCodes.NOT_FOUND, `版本 ${target} 无快照: ${f.relPath}`)
      }
      const dest = ensureInside(ctx.workdirRoot, join(ctx.workdirRoot, f.relPath), 'relPath')
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(snap, dest)
    }
    const reverted = { ...rec, state: 'reverted' as const, ts: nowIso() }
    await this.saveManifest(reverted)
    await this.appendLog(projectId, rec.sessionId ?? `u_${rec.submitter}`, {
      kind: 'artifact',
      role: 'system',
      sender: rec.submitter,
      payload: { artifactId: rec.id, action: 'rollback', toVersion: target },
    }).catch(() => undefined)
    return reverted
  }

  private async saveManifest(rec: ArtifactRecord): Promise<void> {
    const all = await this.readAll(rec.projectId)
    const idx = all.findIndex((a) => a.id === rec.id)
    if (idx >= 0) all[idx] = rec
    else all.push(rec)
    await mkdir(join(this.projectsRoot, rec.projectId), { recursive: true })
    await atomicWriteFile(
      this.manifestFile(rec.projectId),
      all.map((a) => JSON.stringify(a)).join('\n') + '\n',
    )
  }

  /** 列出版本目录（供回退选择）。 */
  async listVersions(projectId: string, artifactId: string): Promise<number[]> {
    await this.get(projectId, artifactId)
    const dir = join(this.projectsRoot, projectId, 'artifact-versions', artifactId)
    const names = await readdir(dir).catch(() => [])
    return names
      .map((n) => Number(n.replace(/^v/, '')))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  }

  /**
   * code 受控编辑结算（D14-⑧/D17-①）：任务 done/terminated 时把该任务
   * code-edits 轨迹涉及的 workdir 文件结算为一条 code artifact（type=code、
   * 默认 code 门不审批 → 初始 approved，B1）。随后清空轨迹。
   */
  async settleCodeAggregation(opts: {
    projectId: string
    actor: string
    taskId: string
    taskTitle: string
    edits: import('../code-edit/code-edit-store.js').CodeEditStore
  }): Promise<ArtifactRecord | null> {
    const relPaths = await opts.edits.listRelPaths(opts.projectId, opts.taskId)
    if (relPaths.length === 0) return null
    const ctx = await this.ctxOf(opts.projectId, opts.actor)

    const id = genId('a_')
    const prev = (await this.readAll(opts.projectId))
      .filter(
        (a) =>
          a.submitter === opts.actor &&
          a.type === 'code' &&
          a.taskId === opts.taskId &&
          a.state !== 'reverted',
      )
      .sort((a, b) => b.version - a.version)[0]
    const version = (prev?.version ?? 0) + 1
    const vdir = join(this.projectsRoot, opts.projectId, 'artifact-versions', id, `v${version}`)
    const files: ArtifactRecord['files'] = []
    let add = 0
    await mkdir(vdir, { recursive: true })
    for (const rel of relPaths) {
      const src = ensureInside(ctx.workdirRoot, join(ctx.workdirRoot, rel), 'relPath')
      const content = await readFile(src).catch(() => null)
      if (content === null) continue
      const snap = ensureInside(vdir, join(vdir, rel))
      await mkdir(dirname(snap), { recursive: true })
      await copyFile(src, snap)
      files.push({
        relPath: rel,
        action: 'add',
        hash: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      })
      add += content.length
    }
    if (files.length === 0) {
      await opts.edits.clear(opts.projectId, opts.taskId)
      return null
    }
    const rec: ArtifactRecord = {
      id,
      type: 'code',
      title: opts.taskTitle || `任务 ${opts.taskId} 代码改动`,
      summary: '任务级受控编辑聚合（D14-⑧）',
      submitter: opts.actor,
      projectId: opts.projectId,
      sessionId: `u_${opts.actor}`,
      taskId: opts.taskId,
      state: 'approved', // code 门默认无审批（B1）
      version,
      files,
      diffSummary: { add, del: 0 },
      prevVersion: prev?.version ?? null,
      approvalId: null,
      versionDir: `artifact-versions/${id}/v${version}`,
      ts: nowIso(),
    }
    await this.saveManifest(rec)
    await this.appendLog(opts.projectId, `u_${opts.actor}`, {
      kind: 'artifact',
      role: 'system',
      sender: opts.actor,
      payload: { artifactId: id, action: 'code-settle', taskId: opts.taskId, version },
    }).catch(() => undefined)
    await opts.edits.clear(opts.projectId, opts.taskId)
    return rec
  }
}
