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
import { AppError, ErrorCodes } from '../../shared/errors.js'
import { genId, nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'
import type { EventBus } from '../../infra/bus/event-bus.js'
import {
  findBusySlot,
  findDuplicateTask,
  isCoordinator,
  normalizeTaskTitle,
  pickDefaultClaim,
  taskTransitionError,
  TASK_STATES,
  type TaskState,
} from '../../domain/fsm/task-state.js'

/** 任务记录文件的项目相对路径。 */
const FILE = 'tasks.jsonl'

// 状态常量与判定规则已归位 domain（P2）；这里 re-export 保持既有调用方（工具层/前端契约）不变。
export { TASK_STATES }
export type { TaskState }

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
  /** 最近一次状态变更时受派人给的说明（完成总结/受阻原因），2026-09-12 */
  resultNote?: string
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

/** 发布结果：duplicate=true 表示命中同题活跃任务（未新建），task 即既有任务。 */
export interface CreateTaskResult {
  task: TaskRecord
  duplicate: boolean
}

/** 发布选项：force=true 时跳过同题去重，强制新建（逃生阀）。 */
export interface PublishOptions {
  force?: boolean
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
    private readonly store: ProjectStore,
    /** assignByAgent=false（乙模式）：非 user 创建一律拒绝 */
    private readonly assignByAgent: boolean,
    private readonly hooks: TaskServiceHooks = {},
  ) {}

  private async readAll(projectId: string): Promise<TaskRecord[]> {
    return this.store.readAll<TaskRecord>(projectId, FILE)
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
   *
   * **跨管理者去重（2026-09-12）**：同一受派人 + 归一化标题相同 + 状态仍在 todo/in_progress
   * 视为同一件事（pm 与 product 同时派同一任务时只留一条）；命中则**不新建**，返回既有任务
   * （`duplicate: true`），由调用方给提出者明确回执。终态任务不参与去重（做完可再派）。
   * `opts.force=true` 跳过去重（确需重复发布时）。
   */
  async create(input: CreateTaskInput, opts: PublishOptions = {}): Promise<CreateTaskResult> {
    const title = input.title.trim()
    if (!title) throw new AppError(ErrorCodes.VALIDATION, '任务标题不能为空')
    if (!this.assignByAgent && input.creator !== 'user') {
      throw new AppError(
        ErrorCodes.CONFLICT,
        '甲模式未开启(task.assignByAgent=false)：任务仅可由 user 创建（乙模式，D15）',
      )
    }
    // 去重检查 + 写入必须在同一把锁内，否则两位管理者并发发布会各写一次（其中一条会被覆盖丢失）
    let result!: CreateTaskResult
    await this.store.mutate<TaskRecord>(input.projectId, FILE, (all) => {
      if (!opts.force) {
        const dup = findDuplicateTask(all, input.assignee, title)
        if (dup) {
          result = { task: dup, duplicate: true }
          return null // 命中重复：不写盘
        }
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
      all.push(rec)
      result = { task: rec, duplicate: false }
      return all
    })
    if (result.duplicate) return result
    // 锁外：广播 + 通知受派人领取
    const rec = result.task
    this.emitUpdated(input.projectId, rec, 'published')
    await this.hooks.notifyClaim?.(input.projectId, rec.assignee, rec).catch(() => undefined)
    return result
  }

  /**
   * 领取任务：todo(/blocked) → in_progress，**只能由受派人本人发起**。
   * taskId 缺省 = 领取该受派人最旧的一条待领取任务。
   * 检查与写入在同一把锁内（防并发重复领取/丢写）。
   */
  async claim(projectId: string, actor: string, taskId?: string): Promise<TaskRecord> {
    let changed = false
    let next!: TaskRecord
    await this.store.mutate<TaskRecord>(projectId, FILE, (all) => {
      let rec: TaskRecord | undefined
      if (taskId) {
        rec = all.find((x) => x.id === taskId)
        if (!rec) throw new AppError(ErrorCodes.NOT_FOUND, `任务不存在: ${taskId}`)
      } else {
        rec = pickDefaultClaim(all, actor)
        if (!rec) {
          throw new AppError(
            ErrorCodes.NOT_FOUND,
            `任务栏上没有待你领取的任务（${actor}）；如已全部领取，请用 task_update 汇报当前任务进度`,
          )
        }
      }
      if (rec.assignee !== actor) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          `任务 ${rec.id} 指派给 ${rec.assignee}，你（${actor}）不能领取；如需调整请让委派人（${rec.creator}）重新安排`,
        )
      }
      // 幂等：已领取 → 不改写、不广播
      if (rec.state === 'in_progress') {
        next = rec
        return null
      }
      if (rec.state !== 'todo' && rec.state !== 'blocked') {
        throw new AppError(
          ErrorCodes.CONFLICT,
          `任务 ${rec.id} 当前状态 ${rec.state}，无法领取（已终态或未发布）`,
        )
      }
      const occupied = findBusySlot(all, actor, rec.id)
      if (occupied) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          `你已有进行中任务 ${occupied.id}「${occupied.title}」；请先完成/终止它，或让委派人调整优先级`,
        )
      }
      const updated: TaskRecord = { ...rec, state: 'in_progress', updatedAt: nowIso() }
      const idx = all.findIndex((x) => x.id === rec.id)
      all[idx] = updated
      next = updated
      changed = true
      return all
    })
    if (changed) this.emitUpdated(projectId, next, 'claimed')
    return next
  }

  /**
   * 状态流转：**默认由受派者自己汇报**（开工/完成/受阻/终止）；
   * 用户、委派人（creator）、甲模式下的协调者（pm/product）也可干预。
   * 锁内只做「读-校验-写」，通知/结算/广播一律放在锁外（避免通知里的 Agent 回合反过来卡住锁）。
   */
  async setState(
    projectId: string,
    taskId: string,
    to: TaskState,
    actor: 'user' | string = 'user',
    /** 受派人/用户的说明：done=完成总结，blocked=受阻原因（落库并随通知带给委派人） */
    note?: string,
  ): Promise<TaskRecord> {
    let cur!: TaskRecord
    let updated!: TaskRecord
    await this.store.mutate<TaskRecord>(projectId, FILE, (all) => {
      const found = all.find((x) => x.id === taskId)
      if (!found) throw new AppError(ErrorCodes.NOT_FOUND, `任务不存在: ${taskId}`)
      cur = found
      this.assertActor(cur, actor)
      this.assertTransition(cur, to)
      // 置 in_progress 前检查单工槽位（每 Agent 至多 1）
      if (to === 'in_progress') {
        const occupied = findBusySlot(all, cur.assignee, taskId)
        if (occupied) {
          throw new AppError(
            ErrorCodes.CONFLICT,
            `实例 ${cur.assignee} 已有进行中任务 ${occupied.id}（每 Agent 至多 1 in_progress；可先置 todo 排队）`,
          )
        }
      }
      const trimmed = note?.trim()
      updated = {
        ...cur,
        state: to,
        updatedAt: nowIso(),
        ...(trimmed ? { resultNote: trimmed } : {}),
      }
      const idx = all.findIndex((x) => x.id === taskId)
      all[idx] = updated
      return all
    })
    const next = { cur, next: updated }
    const { cur: prev } = next
    this.emitUpdated(projectId, next.next, to)
    // D17-① 置终态前先结算未结算 code 改动（结算内部会回调 linkArtifact，故必须在锁外）
    if ((to === 'done' || to === 'terminated') && this.hooks.settle) {
      await this.hooks.settle(projectId, prev).catch(() => undefined)
    }
    // 激活即唤醒（D18-③）：只有"别人替我开工"才需要唤醒；受派者自己置位说明它已在干活
    if (to === 'in_progress' && actor !== prev.assignee) {
      await this.hooks.notifyClaim?.(projectId, prev.assignee, next.next).catch(() => undefined)
    }
    // 完成/受阻/终止 → 通知委派人安排后续
    if (to === 'done' || to === 'blocked' || to === 'terminated') {
      await this.hooks
        .notifyDelegator?.(projectId, next.next, to, actor === 'user' ? 'user' : actor)
        .catch(() => undefined)
    }
    // 槽位释放 → 通知下一位待领取任务的受派人（不再自动开工）
    if (to === 'done' || to === 'terminated') {
      await this.notifyNextQueued(projectId, prev.assignee)
    }
    return next.next
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

  /** 流转合法性判定（规则在 `domain/fsm/task-state.ts`；错误码与文案保持既有口径）。 */
  private assertTransition(cur: TaskRecord, to: TaskState): void {
    const err = taskTransitionError(cur.state, to)
    if (err) throw new AppError(ErrorCodes.CONFLICT, err)
  }

  /** 记 artifact 关联（code 聚合产物结算时由 ArtifactService 调用）。 */
  async linkArtifact(projectId: string, taskId: string, artifactId: string): Promise<void> {
    await this.store.mutate<TaskRecord>(projectId, FILE, (all) => {
      const idx = all.findIndex((x) => x.id === taskId)
      if (idx < 0) return null
      const cur = all[idx]!
      all[idx] = {
        ...cur,
        artifactIds: [...new Set([...cur.artifactIds, artifactId])],
        updatedAt: nowIso(),
      }
      return all
    })
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
      resultNote: rec.resultNote ?? '',
    })
  }

  /**
   * 锁语义（重构 P1）：`tasks.jsonl` 是「读全量 → 改 → 覆盖写」，并发发布会互相覆盖丢任务。
   * 迁移前用本文件自建的 `KeyedLock`；现在由注入的门面 `mutate` 承担（锁归实现层），
   * 且它仍只包住读改写、不跨越通知/结算（那些会触发 Agent 回合，持锁会自锁）。
   */
}

/** 标题归一化：规则在 domain（`normalizeTaskTitle`）；此处 re-export 保持既有调用方不变。 */
export const normalizeTitle = normalizeTaskTitle
