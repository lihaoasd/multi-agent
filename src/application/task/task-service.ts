import type { Clock } from '../../ports/clock'
import type { EventBroadcaster } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { Logger } from '../../ports/logger'
import type { InstanceId, ProjectId } from '../../ports/project'
import type { ProjectStore } from '../../ports/project'
import type { CreateTaskInput, TaskListFilter, TaskRecord, TaskService, TaskStore } from '../../ports/task'
import type { ArtifactService } from '../../ports/artifact'
import type { OrchestrationService } from '../../ports/orchestration'
import { pendingKeyFor, TASK_ACTIVE_STATES, type TaskState } from '../../shared/artifacts'
import { normalizeForSearch } from '../../shared/text'
import { err, ok, type Result } from '../../shared/result'

/**
 * 任务用例（data-storage.md §7、D19-⑤、D17-①）：
 * - 发布（用户经 UI / 上游 Agent 沿出边委派）→ `todo`，撞车去重（同受派人 + 归一化标题 + 活跃状态）；
 * - 受派人 `claim` → `in_progress`（**每 Agent 至多 1 个**，否则 `ERR_CONFLICT`）；
 * - `done`/`blocked`/`terminated` 汇报 → 通知委派人**并指派"据此继续"**（S36/D39）；`done`/`terminated` 前**先结算未结算改动**为 code artifact（可回退）。
 *
 * 通知（"唤醒一轮"）由组合根注入：向受派人 user 会话注入一条系统消息 + 触发 dispatcher.drain。
 */

export interface TaskServiceOptions {
  readonly store: TaskStore
  readonly projects: ProjectStore
  readonly artifacts: ArtifactService
  /** 委派边约束（铁律 2）：Agent 只能沿自己的直接出边派单 */
  readonly orchestration: OrchestrationService
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly broadcaster: EventBroadcaster
  readonly logger: Logger
  /** 向某角色投递系统消息并唤醒一轮（组合根提供；失败不阻断状态流转） */
  readonly notify: (input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly text: string
  }) => Promise<void>
}

/** 归一化标题：去空白/标点 + 小写（撞车去重口径，data-storage §7） */
export function normalizeTaskTitle(title: string): string {
  return normalizeForSearch(title).replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 汇报通知文案（S36/D39）：**不只播报事实，还要指派"据此继续"**——否则委派人被唤醒后
 * 往往只回一句"收到"就停了，子任务结果落不到它的计划里。
 * 前缀保留 `[任务]`（平台任务通知的既有约定）；只点名**所有角色都有**的 `task_update`/`ask_user`，
 * 派单与接手用自然语言描述（`task_assign` 只在 pm 白名单里）。
 */
export function taskReportNotice(input: {
  readonly assignee: string
  readonly taskId: string
  readonly title: string
  readonly state: 'done' | 'blocked' | 'terminated'
  readonly note: string | null
}): string {
  const note = input.note?.trim() ?? ''
  const next: Record<typeof input.state, string> = {
    done: '请据此继续你的计划：基于这个结果推进下一步；若你的任务因此已无后续，用 task_update 汇报你自己任务的结论。',
    blocked: '请立即安排后续：调整方案后重新派单、自己接手，或用 ask_user 向用户澄清——不要停在原地等待。',
    terminated: '请决定是否重新安排这项工作（重新派单 / 自己接手 / 用 ask_user 澄清）。',
  }
  return [
    `[任务] ${input.assignee} 已汇报任务 ${input.taskId}《${input.title}》：${input.state}`,
    ...(note === '' ? [] : [`说明：${note}`]),
    next[input.state],
  ].join('\n')
}

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { store, projects, artifacts, orchestration, ids, clock, broadcaster, logger } = options

  const instanceOf = async (projectId: ProjectId, instanceId: InstanceId): Promise<Result<{ displayName: string }>> => {
    const project = await projects.get(projectId)
    if (!project.ok) return project
    const found = project.value.team.find((item) => item.instanceId === instanceId)
    if (found === undefined) return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
    return ok({ displayName: found.displayName })
  }

  const inProgressOf = async (projectId: ProjectId, instanceId: InstanceId): Promise<TaskRecord | null> => {
    const tasks = await store.list(projectId, { assignee: instanceId, state: 'in_progress' })
    return tasks.ok ? (tasks.value[0] ?? null) : null
  }

  const publish = (projectId: ProjectId, task: TaskRecord): void => {
    broadcaster.broadcast({ type: 'task.updated', payload: { projectId, task } })
  }

  return {
    async create(input: CreateTaskInput) {
      const title = input.title.trim()
      if (title.length === 0) return err('ERR_VALIDATION', '任务标题不能为空')
      if (input.desc.length > 4_000) return err('ERR_VALIDATION', '任务描述过长（≤4000 字）')
      const instance = await instanceOf(input.projectId, input.assignee)
      if (!instance.ok) return instance

      // 委派边约束（orchestration.md §1 铁律 2/4）：Agent 发起的派单必须沿自己的直接出边；
      // 用户（creator=user）不受边约束。越边时**不创建任务**。
      if (input.creator !== 'user') {
        const allowed = await orchestration.canDelegate(input.projectId, input.creator, input.assignee)
        if (!allowed.ok) return allowed
        if (!allowed.value) {
          return err('ERR_ORCHESTRATION_EDGE', `编排图中没有 ${input.creator} → ${input.assignee} 的委派边，不能派单给该角色`, {
            from: input.creator,
            to: input.assignee,
          })
        }
      }

      const existing = await store.list(input.projectId, { assignee: input.assignee })
      if (!existing.ok) return existing
      const normalized = normalizeTaskTitle(title)
      const duplicate = input.force === true
        ? undefined
        : existing.value.find(
            (item) => TASK_ACTIVE_STATES.includes(item.state) && normalizeTaskTitle(item.title) === normalized,
          )
      if (duplicate !== undefined) {
        return ok({ task: duplicate, duplicate: true })
      }

      const nowIso = clock.now().toISOString()
      const record: TaskRecord = {
        id: ids.next('t'),
        title,
        desc: input.desc.trim(),
        creator: input.creator,
        assignee: input.assignee,
        state: 'todo',
        sessionId: input.sessionId,
        artifactIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        note: null,
      }
      const created = await store.create(input.projectId, record)
      if (!created.ok) return created
      publish(input.projectId, created.value)
      // 发布即通知受派人「待领取」（D19-⑤）——通知失败不影响落库结果
      await options
        .notify({
          projectId: input.projectId,
          instanceId: input.assignee,
          text: `[任务] 你有一条待领取任务 ${created.value.id}：${created.value.title}。请用 task_claim 领取后开始。`,
        })
        .catch((cause: unknown) => {
          logger.warn('任务通知失败', { projectId: input.projectId, taskId: created.value.id, message: String(cause) })
        })
      return ok({ task: created.value, duplicate: false })
    },

    async claim(projectId, taskId, assignee) {
      const current = await store.get(projectId, taskId)
      if (!current.ok) return current
      if (current.value.assignee !== assignee) {
        return err('ERR_FORBIDDEN', '只能领取派给自己的任务', { taskId, assignee, owner: current.value.assignee })
      }
      if (current.value.state === 'in_progress') {
        return err('ERR_CONFLICT', '该任务已在进行中', { taskId })
      }
      if (current.value.state !== 'todo') {
        return err('ERR_CONFLICT', `任务当前状态不可领取：${current.value.state}`, { taskId, state: current.value.state })
      }
      const busy = await inProgressOf(projectId, assignee)
      if (busy !== null) {
        return err('ERR_CONFLICT', `你已有进行中的任务（${busy.id}：${busy.title}），完成或终止后才能领取新任务`, {
          taskId,
          holding: busy.id,
        })
      }
      const updated: TaskRecord = { ...current.value, state: 'in_progress', updatedAt: clock.now().toISOString() }
      const saved = await store.update(projectId, updated)
      if (!saved.ok) return saved
      publish(projectId, saved.value)
      return ok(saved.value)
    },

    async setState(projectId, taskId, state: TaskState, runOptions) {
      const current = await store.get(projectId, taskId)
      if (!current.ok) return current
      const task = current.value
      if (task.state === state) {
        return err('ERR_CONFLICT', `任务已是 ${state} 状态`, { taskId, state })
      }
      if (state === 'in_progress' && task.state !== 'todo') {
        return err('ERR_CONFLICT', `只有 todo 任务可以置为进行中（当前 ${task.state}）`, { taskId, state: task.state })
      }
      if (state === 'in_progress') {
        const busy = await inProgressOf(projectId, task.assignee)
        if (busy !== null && busy.id !== taskId) {
          return err('ERR_CONFLICT', `该角色已有进行中的任务（${busy.id}：${busy.title}），不能同时开工两个`, {
            taskId,
            holding: busy.id,
          })
        }
      }

      const artifactIds = [...task.artifactIds]
      // 终结（done/terminated）前先结算未结算改动为 code artifact 快照（D17-①，可回退）
      if (state === 'done' || state === 'terminated') {
        const settled = await artifacts.settle({
          projectId,
          instanceId: task.assignee,
          key: pendingKeyFor({ taskId: task.id, sessionId: task.sessionId, turn: 0 }),
          title: task.title,
          summary: state === 'done' ? `任务完成：${task.title}` : `任务终止前结算：${task.title}`,
          type: 'code',
          taskId: task.id,
          sessionId: task.sessionId,
          turn: 0,
        })
        if (!settled.ok) return settled
        if (settled.value !== null) artifactIds.push(settled.value.id)
      }

      const updated: TaskRecord = {
        ...task,
        state,
        note: runOptions?.note ?? task.note,
        artifactIds,
        updatedAt: clock.now().toISOString(),
      }
      const saved = await store.update(projectId, updated)
      if (!saved.ok) return saved
      publish(projectId, saved.value)

      // 完成/受阻/终止 → 通知委派人**并要它继续**（S36/D39；用户创建的任务不必通知自己）
      if (state === 'done' || state === 'blocked' || state === 'terminated') {
        const creator = saved.value.creator
        if (creator !== 'user' && creator !== saved.value.assignee) {
          await options
            .notify({
              projectId,
              instanceId: creator,
              text: taskReportNotice({
                assignee: saved.value.assignee,
                taskId: saved.value.id,
                title: saved.value.title,
                state,
                note: saved.value.note,
              }),
            })
            .catch((cause: unknown) => {
              logger.warn('任务回报通知失败', { projectId, taskId, message: String(cause) })
            })
        }
      }
      return ok(saved.value)
    },

    async list(projectId: ProjectId, filter?: TaskListFilter) {
      return store.list(projectId, filter)
    },

    async get(projectId: ProjectId, taskId: string) {
      return store.get(projectId, taskId)
    },

    async activeFor(projectId: ProjectId, instanceId: InstanceId) {
      return ok(await inProgressOf(projectId, instanceId))
    },

    async delegatedFor(projectId: ProjectId, instanceId: InstanceId) {
      const tasks = await store.list(projectId, { creator: instanceId })
      if (!tasks.ok) return tasks
      // 只看"派给别人"的（派给自己＝当前任务，另有块）；最近更新在前，截断交给上下文组装
      return ok(
        tasks.value
          .filter((task) => task.assignee !== instanceId)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      )
    },
  }
}
