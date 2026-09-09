/**
 * 轻量任务委派（乙模式 MVP；data-storage §7 / agent-runtime §4 / D15/D16-④/D17-①）。
 * 状态: todo | in_progress | done | blocked | terminated
 * 规则:
 *  - creator 默认 user（UI/会议纪要转出）；甲模式(assignByAgent)才允许 pm_1 等 Agent 创建。
 *  - 每 Agent 至多 1 个 in_progress（D17-① 修订 D16-④）：已有 in_progress 时新任务不可置位
 *    （无静默回退，返回 ERR_CONFLICT，可先置 todo）；槽位仅由 done(用户确认) 或 terminated(用户终止) 释放。
 *  - in_progress 置位即「激活即唤醒」（D18-③）：向受派者 user 会话注入唤醒消息触发一轮处理。
 *  - done/terminated 为终态（本 MVP 不提供重开；见修改记录）。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'

export const TASK_STATES = ['todo', 'in_progress', 'done', 'blocked', 'terminated'] as const
export type TaskState = (typeof TASK_STATES)[number]

export interface TaskRecord {
  id: string
  title: string
  desc: string
  creator: 'user' | string
  assignee: string
  state: TaskState
  /** 执行会话（受派者 user 会话 u_<iid>）；sourceRef=来源（会议/产出物）见 data-storage §7 */
  sessionId: string
  artifactIds: string[]
  ts: string
  updatedAt: string
}

export interface CreateTaskInput {
  projectId: string
  title: string
  desc?: string
  creator: 'user' | string
  assignee: string
  sessionId?: string
}

export class TaskService {
  /** assignByAgent=false（乙模式）：非 user 创建一律拒绝 */
  constructor(
    private readonly projectsRoot: string,
    private readonly assignByAgent: boolean,
    private readonly wake: (
      projectId: string,
      assignee: string,
      title: string,
      taskId: string,
    ) => Promise<void>,
    /** done/terminated 结算钩子：先结算未结算 code 改动再置终态（D17-①） */
    private readonly settle?: (projectId: string, task: TaskRecord) => Promise<void>,
  ) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'tasks.jsonl')
  }

  private async readAll(projectId: string): Promise<TaskRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId), 'utf8')
    } catch {
      return []
    }
    const out: TaskRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as TaskRecord)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  async list(
    projectId: string,
    filter: { assignee?: string; state?: TaskState } = {},
  ): Promise<TaskRecord[]> {
    let all = await this.readAll(projectId)
    if (filter.assignee) all = all.filter((t) => t.assignee === filter.assignee)
    if (filter.state) all = all.filter((t) => t.state === filter.state)
    return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  private async get(projectId: string, taskId: string): Promise<TaskRecord> {
    const t = (await this.readAll(projectId)).find((x) => x.id === taskId)
    if (!t) throw new AppError(ErrorCodes.NOT_FOUND, `任务不存在: ${taskId}`)
    return t
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const title = input.title.trim()
    if (!title) throw new AppError(ErrorCodes.VALIDATION, '任务标题不能为空')
    if (!this.assignByAgent && input.creator !== 'user') {
      throw new AppError(
        ErrorCodes.CONFLICT,
        '甲模式未开启(task.assignByAgent=false)：任务仅可由 user 创建（乙模式，D15）',
      )
    }
    const ts = nowIso()
    const rec: TaskRecord = {
      id: genId('t_'),
      title,
      desc: input.desc?.trim() ?? '',
      creator: input.creator,
      assignee: input.assignee,
      state: 'todo',
      sessionId: input.sessionId ?? `u_${input.assignee}`,
      artifactIds: [],
      ts,
      updatedAt: ts,
    }
    await this.rewrite(input.projectId, rec)
    return rec
  }

  /** 状态流转；由用户（UI）驱动。 */
  async setState(
    projectId: string,
    taskId: string,
    to: TaskState,
    actor: 'user' | string = 'user',
  ): Promise<TaskRecord> {
    if (actor !== 'user' && !this.assignByAgent) {
      throw new AppError(ErrorCodes.CONFLICT, '甲模式未开启：状态仅可由 user 流转')
    }
    const cur = await this.get(projectId, taskId)
    const next: TaskRecord = { ...cur, state: to, updatedAt: nowIso() }
    this.assertTransition(cur, to, actor)

    // 置 in_progress 前检查单工槽位（每 Agent 至多 1）
    if (to === 'in_progress') {
      const occupied = (await this.list(projectId, { assignee: cur.assignee })).find(
        (t) => t.id !== taskId && t.state === 'in_progress',
      )
      if (occupied) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          `实例 ${cur.assignee} 已有进行中任务 ${occupied.id}（每 Agent 至多 1 in_progress；可先置 todo 排队）`,
        )
      }
    }
    // D17-① 先结算未结算 code 改动，再置终态（done/terminated）
    if ((to === 'done' || to === 'terminated') && this.settle) {
      await this.settle(projectId, cur)
    }
    await this.rewrite(projectId, next)
    // 激活即唤醒（D18-③）
    if (to === 'in_progress') {
      await this.wake(projectId, cur.assignee, cur.title, cur.id).catch(() => undefined)
    }
    return next
  }

  private assertTransition(cur: TaskRecord, to: TaskState, actor: string): void {
    const from = cur.state
    const allow: Record<string, TaskState[]> = {
      todo: ['in_progress', 'blocked'],
      blocked: ['todo'],
      in_progress: ['done', 'terminated'],
      done: [],
      terminated: [],
    }
    const ok = (allow[from] ?? []).includes(to)
    if (!ok) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `非法状态流转 ${from} → ${to}（允许: ${(allow[from] ?? []).join(', ') || '无（终态）'}）`,
      )
    }
    // done 需用户确认；terminated 仅用户显式终止
    if (to === 'done' && actor !== 'user') {
      throw new AppError(ErrorCodes.CONFLICT, '任务完成需用户确认（done 仅可由 user 置位）')
    }
    if (to === 'terminated' && actor !== 'user') {
      throw new AppError(ErrorCodes.CONFLICT, '任务终止仅可由用户显式执行')
    }
  }

  /** 记 artifact 关联（code 聚合产物结算时由 ArtifactService 调用）。 */
  async linkArtifact(projectId: string, taskId: string, artifactId: string): Promise<void> {
    const cur = await this.get(projectId, taskId)
    const next = {
      ...cur,
      artifactIds: [...new Set([...cur.artifactIds, artifactId])],
      updatedAt: nowIso(),
    }
    await this.rewrite(projectId, next)
  }

  private async rewrite(projectId: string, rec: TaskRecord): Promise<void> {
    const all = await this.readAll(projectId)
    const idx = all.findIndex((x) => x.id === rec.id)
    if (idx >= 0) all[idx] = rec
    else all.push(rec)
    await fs.mkdir(join(this.projectsRoot, projectId), { recursive: true })
    await atomicWriteFile(this.file(projectId), all.map((x) => JSON.stringify(x)).join('\n') + '\n')
  }
}
