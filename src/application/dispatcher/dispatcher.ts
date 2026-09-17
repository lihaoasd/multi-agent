import type { Clock } from '../../ports/clock'
import type {
  AgentStatus,
  Dispatcher,
  DispatcherState,
  DispatcherStateStore,
} from '../../ports/dispatcher'
import type { EventBroadcaster } from '../../ports/events'
import type { LockManager } from '../../ports/lock'
import type { Logger } from '../../ports/logger'
import type { ProjectStore } from '../../ports/project'
import type { NewEvent, StoredEvent } from '../../ports/session'
import type { TurnRunner } from '../../ports/turn'
import { err, ok, type Result } from '../../shared/result'
import type { SessionService } from '../session/session-service'

export interface DispatcherOptions {
  readonly stateStore: DispatcherStateStore
  readonly projectStore: ProjectStore
  readonly sessions: SessionService
  readonly runner: TurnRunner
  readonly approvals: { hasPending(projectId: string, instanceId: string): Promise<boolean> }
  /** 待答复询问同样让占用者进入 `waiting`（D19-⑦） */
  readonly questions: { hasPending(projectId: string, instanceId: string): Promise<boolean> }
  readonly broadcaster: EventBroadcaster
  readonly lock: LockManager
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * 单工调度器（agent-runtime.md §2、D11/D18-③/④、D19-⑥）。
 *
 * 真相与投影：
 * - **occupancy = 运行期占用唯一真相**（落 `runtime.state.json`）；`AgentStatus.state` 是由它派生的投影。
 * - **队列不另存**：队列 = 日志中 `seq > lastHandledSeq` 的未处理用户消息（重启后可重建）。
 *
 * 单工不变式：任一 Agent 同一时刻至多一个活动会话；忙时新消息只落盘排队，不打断当前回合。
 * 游标在**回合结束后**推进（至少一次语义：崩溃时宁可重放，也不丢消息）。
 * 中断口径（S37）：**暂停**＝挂起（游标不推进，消息留在队列，恢复后补处理）；**停止生成**＝本条作废
 * （游标照常推进，不再重放），两者都**不再续跑剩余队列**。
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { stateStore, projectStore, sessions, runner, approvals, broadcaster, lock, clock, logger } = options
  /**
   * 运行中回合的中断句柄：暂停/停止时 abort，回合在可中断点收尾（D19-⑥）。
   * `reason` 决定收尾口径（S37）：`pause`=挂起（游标不推进，消息留在队列、恢复后补处理）；
   * `stop`=停止生成（本条作废不重放，剩余队列留给用户下次触发）。
   */
  const activeTurns = new Map<string, { readonly controller: AbortController; reason: 'pause' | 'stop' | null }>()
  /**
   * 暂停意图（内存即时可见，S37 修复）：`drain` 持同一把 keyed lock **跑完整个队列**，
   * 因此 `setPaused` 只能等锁释放才落盘——那时 Agent 已经把队列干完了，"暂停"等于没停。
   * 意图在取锁**之前**登记，drain 的循环据此立即收敛；持久标记仍由 `stateStore` 负责。
   */
  const pauseIntent = new Set<string>()

  const abortActiveTurn = (instanceId: string, reason: 'pause' | 'stop'): boolean => {
    const active = activeTurns.get(instanceId)
    if (active === undefined) return false
    active.reason = reason
    active.controller.abort()
    return true
  }

  const loadState = async (projectId: string): Promise<Result<DispatcherState>> => stateStore.load(projectId)

  /**
   * 读改写（同一把项目锁内）：**不能用陈旧快照整份覆盖**──
   * 回合内可能嵌套为别的 Agent 触发 drain（例如委派通知），覆盖写会丢掉内层刚写入的游标，
   * 表现为同一条队列消息被重复处理（S9 验收发现的缺陷）。
   */
  const updateState = async (
    projectId: string,
    mutate: (current: DispatcherState) => DispatcherState,
  ): Promise<Result<DispatcherState>> => stateStore.update(projectId, mutate)

  const publishState = (projectId: string, instanceId: string, state: string, sessionId: string | null): void => {
    broadcaster.broadcast({ type: 'agent.state', payload: { projectId, instanceId, state, sessionId } })
  }

  const pendingMessages = async (
    projectId: string,
    instanceId: string,
    cursor: number,
  ): Promise<Result<readonly StoredEvent[]>> => {
    const sessionId = sessions.sessionIdFor(instanceId)
    const window = await sessions.window(projectId, sessionId, { fromSeq: cursor + 1 })
    if (!window.ok) return window
    return ok(
      window.value.filter(
        (event) => event.kind === 'message' && event.payload['role'] === 'user',
      ),
    )
  }

  const drainLocked = async (projectId: string, instanceId: string): Promise<Result<{ handled: number }>> => {
    const project = await projectStore.get(projectId)
    if (!project.ok) return project
    const instance = project.value.team.find((item) => item.instanceId === instanceId)
    if (instance === undefined) {
      return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
    }
    if (!instance.enabled) {
      return err('ERR_CONFLICT', '实例已停用，不再领取新任务（D14-9）', { instanceId })
    }

    let state = await loadState(projectId)
    if (!state.ok) return state
    if (state.value.paused[instanceId] === true || pauseIntent.has(instanceId)) {
      return ok({ handled: 0 })
    }
    if (state.value.occupancy[instanceId] !== undefined) {
      return ok({ handled: 0 })
    }

    const sessionId = sessions.sessionIdFor(instanceId)
    let handled = 0

    for (;;) {
      // 暂停可能落在"上一回合刚收尾、下一回合还没起"的缝里：意图在内存里即时可见（S37）
      if (pauseIntent.has(instanceId)) break
      const cursor = state.value.lastHandledSeq[instanceId] ?? 0
      const pending = await pendingMessages(projectId, instanceId, cursor)
      if (!pending.ok) return pending
      const next = pending.value[0]
      if (next === undefined) break

      const turn = (state.value.turns[instanceId] ?? 0) + 1
      const startedAt = clock.now().toISOString()

      // 占位 → 落盘（先盘后推由 EventPipeline 保证）
      const savedBusy = await updateState(projectId, (current) => ({
        ...current,
        occupancy: {
          ...current.occupancy,
          [instanceId]: { type: 'user', sessionId, since: startedAt },
        },
        turns: { ...current.turns, [instanceId]: turn },
      }))
      if (!savedBusy.ok) return savedBusy
      publishState(projectId, instanceId, 'working', sessionId)

      const emit = async (event: NewEvent): Promise<Result<StoredEvent>> => {
        const appended = await sessions.append(projectId, sessionId, [event])
        if (!appended.ok) return appended
        const stored = appended.value[0]
        if (stored === undefined) return err('ERR_INTERNAL', '事件落盘后丢失', { sessionId })
        return ok(stored)
      }

      const text = typeof next.payload['text'] === 'string' ? (next.payload['text'] as string) : ''
      const handle: { readonly controller: AbortController; reason: 'pause' | 'stop' | null } = {
        controller: new AbortController(),
        reason: null,
      }
      activeTurns.set(instanceId, handle)
      let turnResult: Result<void>
      try {
        turnResult = await runner.runTurn({
          projectId,
          sessionId,
          instanceId,
          sessionType: 'user',
          turn,
          userText: text,
          signal: handle.controller.signal,
          emit,
        })
      } catch (cause) {
        turnResult = err('ERR_INTERNAL', cause instanceof Error ? cause.message : String(cause))
      } finally {
        activeTurns.delete(instanceId)
      }

      if (!turnResult.ok) {
        logger.warn('回合执行失败', {
          projectId,
          instanceId,
          code: turnResult.error.code,
          message: turnResult.error.message,
        })
        await emit({
          kind: 'error',
          turn,
          payload: { errorCode: turnResult.error.code, message: turnResult.error.message },
        })
      }

      // 被用户中断：把"事实"落进会话日志（S21/D27：平台不再判定未完成回合，Agent 靠日志自查）
      if (handle.reason !== null) {
        await emit({
          kind: 'state',
          turn,
          payload: {
            turnAborted: true,
            reason: handle.reason,
            note:
              handle.reason === 'pause'
                ? '用户暂停，回合在可中断点收尾；本条消息保留在队列，恢复后补处理'
                : '用户停止生成，回合在可中断点收尾；本条不再重放',
          },
        })
      }

      // 释放占用 + 推进游标（回合结束后推进：崩溃宁可重放不丢消息）
      // 暂停=挂起：**游标不推进**（消息留在队列，恢复后补处理，规则 26）；停止生成=本条作废，游标照常推进
      const holdCursor = handle.reason === 'pause'
      const savedIdle = await updateState(projectId, (current) => ({
        ...current,
        occupancy: Object.fromEntries(Object.entries(current.occupancy).filter(([key]) => key !== instanceId)),
        ...(holdCursor ? {} : { lastHandledSeq: { ...current.lastHandledSeq, [instanceId]: next.seq } }),
      }))
      if (!savedIdle.ok) return savedIdle
      state = savedIdle
      publishState(projectId, instanceId, 'idle', sessionId)
      handled += 1
      // 中断后不再续跑队列：暂停等恢复；停止生成把剩余消息留给用户下次触发
      if (handle.reason !== null) break
    }

    return ok({ handled })
  }

  const drain = async (projectId: string, instanceId: string): Promise<Result<{ handled: number }>> =>
    lock.withLock(`agent:${instanceId}`, () => drainLocked(projectId, instanceId))

  const statusOf = async (projectId: string): Promise<Result<readonly AgentStatus[]>> => {
    const project = await projectStore.get(projectId)
    if (!project.ok) return project
    const state = await loadState(projectId)
    if (!state.ok) return state

    const statuses: AgentStatus[] = []
    for (const instance of project.value.team) {
      const occupancy = state.value.occupancy[instance.instanceId]
      const cursor = state.value.lastHandledSeq[instance.instanceId] ?? 0
      const pending = await pendingMessages(projectId, instance.instanceId, cursor)
      const waiting =
        occupancy !== undefined &&
        ((await approvals.hasPending(projectId, instance.instanceId)) ||
          (await options.questions.hasPending(projectId, instance.instanceId)))
      statuses.push({
        instanceId: instance.instanceId,
        enabled: instance.enabled,
        state: occupancy === undefined ? 'idle' : waiting ? 'waiting' : 'working',
        // 暂停意图（内存）即时可见：drain 已收敛但标记还没落盘的窗口里，投影也要说"已暂停"（S37）
        paused: state.value.paused[instance.instanceId] === true || pauseIntent.has(instance.instanceId),
        sessionId: occupancy?.sessionId ?? null,
        queued: pending.ok ? pending.value.length : 0,
      })
    }
    return ok(statuses)
  }

  return {
    async submitUserMessage(input): Promise<Result<{ seq: number; queued: boolean }>> {
      const meta = await sessions.get(input.projectId, input.sessionId)
      if (!meta.ok) return meta

      const project = await projectStore.get(input.projectId)
      if (!project.ok) return project
      const instanceId = meta.value.participants.agents[0]
      if (instanceId === undefined) {
        return err('ERR_VALIDATION', '会话没有绑定角色实例', { sessionId: input.sessionId })
      }
      const instance = project.value.team.find((item) => item.instanceId === instanceId)
      if (instance === undefined) {
        return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId: input.projectId })
      }
      if (!instance.enabled) {
        return err('ERR_CONFLICT', '该角色已停用，会话只读（可在团队中重新启用）', { instanceId })
      }

      const text = input.text.trim()
      if (text.length === 0) return err('ERR_VALIDATION', '消息内容不能为空')
      if (text.length > 20_000) return err('ERR_VALIDATION', '消息过长（≤ 20000 字）', { length: text.length })

      const state = await loadState(input.projectId)
      if (!state.ok) return state
      const busy = state.value.occupancy[instanceId] !== undefined
      const paused = state.value.paused[instanceId] === true

      const appended = await sessions.append(input.projectId, input.sessionId, [
        { kind: 'message', turn: 0, payload: { role: 'user', sender: 'user', text, content: { text } } },
      ])
      if (!appended.ok) return appended
      const seq = appended.value[0]?.seq ?? 0

      // 忙或暂停时只入队（不打断当前回合 / 不领取新活）；否则立刻派发并处理这条消息
      let processed = false
      if (!busy && !paused) {
        const drained = await drain(input.projectId, instanceId)
        if (!drained.ok) return drained
        processed = drained.value.handled > 0
      }
      // queued = 本条消息尚未被处理（忙 / 暂停两条路径都会落到这里）
      return ok({ seq, queued: !processed })
    },

    drain,

    status: statusOf,

    /** 中断当前回合（停止生成）：回合在可中断点收尾；本条消息作废，剩余队列留待下次触发 */
    abortTurn(projectId: string, instanceId: string): boolean {
      void projectId
      return abortActiveTurn(instanceId, 'stop')
    },

    async resetStaleOccupancy(projectId: string): Promise<Result<number>> {
      // 进程重启后不可能仍有活跃回合：清掉占用，游标保持不变（未处理消息仍在队列里，等用户决定）
      // 不额外加锁：stateStore.save 内部已按项目串行；本操作只在启动期执行一次。
      const state = await loadState(projectId)
      if (!state.ok) return state
      const stale = Object.keys(state.value.occupancy)
      if (stale.length === 0) return ok(0)
      const saved = await updateState(projectId, (current) => ({ ...current, occupancy: {} }))
      if (!saved.ok) return saved
      for (const instanceId of stale) publishState(projectId, instanceId, 'idle', null)
      return ok(stale.length)
    },

    async resumeQueued(projectId: string): Promise<Result<{ resumed: readonly string[] }>> {
      const statuses = await statusOf(projectId)
      if (!statuses.ok) return statuses
      const resumed: string[] = []
      for (const status of statuses.value) {
        if (!status.enabled || status.paused || status.state !== 'idle' || status.queued === 0) continue
        const drained = await drain(projectId, status.instanceId)
        if (drained.ok && drained.value.handled > 0) resumed.push(status.instanceId)
      }
      return ok({ resumed })
    },

    async setPaused(projectId: string, instanceId: string, paused: boolean): Promise<Result<AgentStatus>> {
      const project = await projectStore.get(projectId)
      if (!project.ok) return project
      if (!project.value.team.some((item) => item.instanceId === instanceId)) {
        return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
      }
      // **必须在取锁之前**（S37 修复）：`drain` 持同一把锁跑完整个队列，
      // 等锁释放时 Agent 早已把活干完，"暂停"名存实亡。
      if (paused) {
        pauseIntent.add(instanceId)
        abortActiveTurn(instanceId, 'pause')
      } else {
        pauseIntent.delete(instanceId)
      }
      return lock.withLock(`agent:${instanceId}`, async () => {
        const state = await loadState(projectId)
        if (!state.ok) return state
        if ((state.value.paused[instanceId] === true) === paused) {
          return err('ERR_CONFLICT', paused ? '该角色已暂停' : '该角色未暂停', { instanceId })
        }
        const saved = await updateState(projectId, (current) => ({
          ...current,
          paused: { ...current.paused, [instanceId]: paused },
        }))
        if (!saved.ok) return saved
        publishState(projectId, instanceId, 'idle', null)
        const statuses = await statusOf(projectId)
        if (!statuses.ok) return statuses
        const status = statuses.value.find((item) => item.instanceId === instanceId)
        return status === undefined
          ? err('ERR_INTERNAL', '暂停后状态丢失', { instanceId })
          : ok(status)
      })
    },
  }
}

