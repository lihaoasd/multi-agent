/**
 * 轻量任务委派（任务栏：发布 → 通知领取 → 完成回通知委派人）
 * data-storage §7 / agent-runtime §4 / D15/D16-④/D17-①；2026-09-12 改为发布-领取制。
 *
 * 状态: todo(已发布·待领取) | in_progress(已领取·进行中) | done | blocked | terminated
 * 规则:
 *  - creator 默认 user（UI/会议纪要转出）；甲模式(assignByAgent)才允许 pm/product 等 Agent 发布。
 *  - **发布即通知**：create() 后向受派人 user 会话注入系统消息并唤醒一轮，受派人自行 `claim()` 领取。
 *  - **领取**：todo → in_progress，只能由受派人本人发起（claim）；每 Agent 至多 1 个 in_progress，
 *    槽位被占则拒绝（不静默排队开工）。
 *  - **完成回通知**：done/terminated/blocked 时通知 creator（委派人）安排后续；
 *    槽位释放只**通知**下一位待领取任务，不再自动开工。
 *  - 状态变更经 EventBus 推 `task.updated`，任务栏实时刷新。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'
import type { EventBus } from '../../infra/bus/event-bus.js'

export const TASK_STATES = ['todo', 'in_progress', 'done', 'blocked', 'terminated'] as const
export type TaskState = (typeof TASK_STATES)[number]

/** 协调者角色前缀（甲模式下可干预任务；与 loop-runner DISPATCH_ROLES 一致），实例 id 形如 pm_1。 */
const COORDINATOR_PREFIXES = ['pm', 'product']

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

/** 通知类事件：受派人需要领取 / 委派人需要安排后续。 */
export type DelegatorEvent = 'done' | 'blocked' | 'terminated'

export interface TaskServiceHooks {
  /** 通知受派人领取任务（写系统消息 + 唤醒一轮） */
  notifyClaim?: (projectId: string, assignee: string, task: TaskRecord) => Promise<void>
  /** 通知委派人：任务已 done/blocked/terminated，请安排后续 */
  notifyDelegator?: (
    projectId: string,
    task: TaskRecord,
    event: DelegatorEvent,
    by: string,
  ) => Promise<void>
  /** done/terminated 结算钩子：先结算未结算 code 改动再置终态（D17-①） */
  settle?: (projectId: string, task: TaskRecord) => Promise<void>
  /** 任务状态广播（任务栏实时刷新） */
  bus?: EventBus
}

export class TaskService {
  constructor(
    private readonly projectsRoot: string,
    /** assignByAgent=false（乙模式）：非 user 创建一律拒绝 */
    private readonly assignByAgent: boolean,
    private readonly hooks: TaskServiceHooks = {},
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

  async get(projectId: string, taskId: string): Promise<TaskRecord> {
    const t = (await this.readAll(projectId)).find((x) => x.id === taskId)
    if (!t) throw new AppError(ErrorCodes.NOT_FOUND, `任务不存在: ${taskId}`)
    return t
  }

  /**
   * 发布任务到任务栏（state=todo 待领取）→ 广播 → 通知受派人领取。
   * 四个入口（task_assign / 回复 JSON / POST /tasks / 纪要转任务）都走这里，语义统一。
   */
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
    this.emitUpdated(input.projectId, rec, 'published')
    await this.hooks.notifyClaim?.(input.projectId, rec.assignee, rec).catch(() => undefined)
    return rec
  }

  /**
   * 领取任务：todo(/blocked) → in_progress，**只能由受派人本人发起**。
   * taskId 缺省 = 领取该受派人最旧的一条待领取任务。
   */
  async claim(projectId: string, actor: string, taskId?: string): Promise<TaskRecord> {
    let rec: TaskRecord
    if (taskId) {
      rec = await this.get(projectId, taskId)
    } else {
      const mine = (await this.list(projectId, { assignee: actor, state: 'todo' })).sort((a, b) =>
        a.ts < b.ts ? -1 : 1,
      )
      const next = mine[0]
      if (!next) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          `任务栏上没有待你领取的任务（${actor}）；如已全部领取，请用 task_update 汇报当前任务进度`,
        )
      }
      rec = next
    }
    if (rec.assignee !== actor) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `任务 ${rec.id} 指派给 ${rec.assignee}，你（${actor}）不能领取；如需调整请让委派人（${rec.creator}）重新安排`,
      )
    }
    if (rec.state === 'in_progress') return rec // 幂等：已领取
    if (rec.state !== 'todo' && rec.state !== 'blocked') {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `任务 ${rec.id} 当前状态 ${rec.state}，无法领取（已终态或未发布）`,
      )
    }
    const occupied = (await this.list(projectId, { assignee: actor })).find(
      (t) => t.id !== rec.id && t.state === 'in_progress',
    )
    if (occupied) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `你已有进行中任务 ${occupied.id}「${occupied.title}」；请先完成/终止它，或让委派人调整优先级`,
      )
    }
    const next: TaskRecord = { ...rec, state: 'in_progress', updatedAt: nowIso() }
    await this.rewrite(projectId, next)
    this.emitUpdated(projectId, next, 'claimed')
    return next
  }

  /**
   * 状态流转：**默认由受派者自己汇报**（开工/完成/受阻/终止）；
   * 用户、委派人（creator）、甲模式下的协调者（pm/product）也可干预。
   */
  async setState(
    projectId: string,
    taskId: string,
    to: TaskState,
    actor: 'user' | string = 'user',
  ): Promise<TaskRecord> {
    const cur = await this.get(projectId, taskId)
    this.assertActor(cur, actor)
    this.assertTransition(cur, to)
    const next: TaskRecord = { ...cur, state: to, updatedAt: nowIso() }

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
    if ((to === 'done' || to === 'terminated') && this.hooks.settle) {
      await this.hooks.settle(projectId, cur)
    }
    await this.rewrite(projectId, next)
    this.emitUpdated(projectId, next, to)
    // 激活即唤醒（D18-③）：只有"别人替我开工"才需要唤醒；受派者自己置位说明它已在干活
    if (to === 'in_progress' && actor !== cur.assignee) {
      await this.hooks.notifyClaim?.(projectId, cur.assignee, next).catch(() => undefined)
    }
    // 完成/受阻/终止 → 通知委派人安排后续
    if (to === 'done' || to === 'blocked' || to === 'terminated') {
      await this.hooks
        .notifyDelegator?.(projectId, next, to, actor === 'user' ? 'user' : actor)
        .catch(() => undefined)
    }
    // 槽位释放 → 通知下一位待领取任务的受派人（不再自动开工）
    if (to === 'done' || to === 'terminated') {
      await this.notifyNextQueued(projectId, cur.assignee)
    }
    return next
  }

  /** 通知该受派人"任务栏上还有待领取任务"（槽位刚释放时调用；不改状态）。 */
  private async notifyNextQueued(projectId: string, assignee: string): Promise<void> {
    const queued = (await this.list(projectId, { assignee, state: 'todo' })).sort((a, b) =>
      a.ts < b.ts ? -1 : 1,
    )
    const next = queued[0]
    if (!next) return
    await this.hooks.notifyClaim?.(projectId, assignee, next).catch(() => undefined)
  }

  /** 谁能改这条任务：user / 受派人本人 / 委派人(creator) /（甲模式下）协调者(pm·product)。 */
  private assertActor(cur: TaskRecord, actor: string): void {
    if (actor === 'user' || actor === cur.assignee || actor === cur.creator) return
    if (this.assignByAgent && isCoordinator(actor)) return
    throw new AppError(
      ErrorCodes.CONFLICT,
      `任务 ${cur.id} 由受派人 ${cur.assignee} 自己汇报状态（或用户/委派人 ${cur.creator} 干预）；${actor} 无权修改`,
    )
  }

  private assertTransition(cur: TaskRecord, to: TaskState): void {
    const from = cur.state
    const allow: Record<string, TaskState[]> = {
      todo: ['in_progress', 'blocked'],
      blocked: ['todo', 'in_progress'],
      in_progress: ['done', 'terminated', 'blocked'],
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

  /** 任务栏实时刷新：状态/发布/领取都广播。 */
  private emitUpdated(projectId: string, rec: TaskRecord, action: string): void {
    this.hooks.bus?.emit('task.updated', projectId, undefined, {
      taskId: rec.id,
      action,
      state: rec.state,
      assignee: rec.assignee,
      creator: rec.creator,
      title: rec.title,
    })
  }

  /** 唤醒受派人（"别人替我开工"或排队提醒）：注入系统消息并触发一轮。 */
  private async rewrite(projectId: string, rec: TaskRecord): Promise<void> {
    const all = await this.readAll(projectId)
    const idx = all.findIndex((x) => x.id === rec.id)
    if (idx >= 0) all[idx] = rec
    else all.push(rec)
    await fs.mkdir(join(this.projectsRoot, projectId), { recursive: true })
    await atomicWriteFile(this.file(projectId), all.map((x) => JSON.stringify(x)).join('\n') + '\n')
  }
}

/** 实例 id 是否为协调者角色（pm_1 / product_1）。 */
function isCoordinator(actor: string): boolean {
  return COORDINATOR_PREFIXES.some((p) => actor === p || actor.startsWith(`${p}_`))
}
