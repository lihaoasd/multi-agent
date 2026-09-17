import type { Clock } from '../../ports/clock'
import type { Dispatcher, DispatcherStateStore } from '../../ports/dispatcher'
import type { Logger } from '../../ports/logger'
import type { ProjectId, ProjectStore } from '../../ports/project'
import type { RuntimeAgentView, RuntimeService, RuntimeSnapshot } from '../../ports/runtime'
import type { TaskService } from '../../ports/task'
import type { SessionService } from '../session/session-service'
import { ok, type Result } from '../../shared/result'

/**
 * 运行控制（D17-⑥、orchestration.md §5）：
 * - `snapshot`：「n 个 Agent 正在工作」细条数据（占用者 + 当前任务 + 最近 plan 状态）；
 * - `stop`：`turn`=停当前回合输出（队列保留，任务继续）；`task`=终止当前任务（**先结算未结算改动**为 code artifact）。
 * ⚠️ S21/D27：未完成回合的判定与恢复已从本服务移除（改由 Agent 自查 + `ask_user` 询问）。
 */

export interface RuntimeServiceOptions {
  readonly projects: ProjectStore
  readonly sessions: SessionService
  readonly tasks: TaskService
  readonly dispatcher: Dispatcher
  readonly stateStore: DispatcherStateStore
  readonly clock: Clock
  readonly logger: Logger
}

export function createRuntimeService(options: RuntimeServiceOptions): RuntimeService {
  const planStatusOf = async (
    projectId: ProjectId,
    sessionId: string,
    turn: number,
  ): Promise<string | null> => {
    const plans = await options.sessions.history(projectId, sessionId, ['plan'], { limit: 20 })
    if (!plans.ok) return null
    const last = [...plans.value].reverse().find((event) => event.turn === turn) ?? plans.value[plans.value.length - 1]
    const status = last?.payload['status']
    return typeof status === 'string' ? status : null
  }

  return {
    async snapshot(projectId): Promise<Result<RuntimeSnapshot>> {
      const project = await options.projects.get(projectId)
      if (!project.ok) return project
      const statuses = await options.dispatcher.status(projectId)
      if (!statuses.ok) return statuses
      const state = await options.stateStore.load(projectId)
      if (!state.ok) return state

      const working: RuntimeAgentView[] = []
      let idle = 0
      let paused = 0
      let queuedTotal = 0
      for (const status of statuses.value) {
        queuedTotal += status.queued
        if (status.paused) paused += 1
        if (status.state === 'idle') {
          idle += 1
          continue
        }
        const instance = project.value.team.find((item) => item.instanceId === status.instanceId)
        const sessionId = status.sessionId ?? options.sessions.sessionIdFor(status.instanceId)
        const active = await options.tasks.activeFor(projectId, status.instanceId)
        const turn = state.value.turns[status.instanceId] ?? 0
        working.push({
          instanceId: status.instanceId,
          displayName: instance?.displayName ?? status.instanceId,
          state: status.state,
          paused: status.paused,
          queued: status.queued,
          sessionId,
          turn,
          startedAt: state.value.occupancy[status.instanceId]?.since ?? null,
          taskTitle: active.ok ? (active.value?.title ?? null) : null,
          planStatus: await planStatusOf(projectId, sessionId, turn),
        })
      }
      return ok({ projectId, working, idle, paused, queuedTotal })
    },

    async stop(input) {
      const project = await options.projects.get(input.projectId)
      if (!project.ok) return project
      if (!project.value.team.some((item) => item.instanceId === input.instanceId)) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: `实例不存在：${input.instanceId}` } }
      }

      const aborted = options.dispatcher.abortTurn(input.projectId, input.instanceId)
      let taskId: string | null = null
      let settledArtifactId: string | null = null

      if (input.scope === 'task') {
        const active = await options.tasks.activeFor(input.projectId, input.instanceId)
        if (active.ok && active.value !== null) {
          const before = active.value.artifactIds.length
          const terminated = await options.tasks.setState(input.projectId, active.value.id, 'terminated', {
            actor: 'user',
            note: '用户停止任务',
          })
          if (!terminated.ok) return terminated
          taskId = terminated.value.id
          settledArtifactId =
            terminated.value.artifactIds.length > before
              ? (terminated.value.artifactIds[terminated.value.artifactIds.length - 1] ?? null)
              : null
        }
      }

      const statuses = await options.dispatcher.status(input.projectId)
      const queued = statuses.ok
        ? (statuses.value.find((item) => item.instanceId === input.instanceId)?.queued ?? 0)
        : 0
      options.logger.info('运行控制：停止', {
        projectId: input.projectId,
        instanceId: input.instanceId,
        scope: input.scope,
        aborted,
        taskId,
        settledArtifactId,
        queued,
      })
      return ok({ aborted, taskId, settledArtifactId, queued })
    },
  }
}
