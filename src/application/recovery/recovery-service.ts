import type { Clock } from '../../ports/clock'
import type { InstanceId, ProjectId } from '../../ports/project'
import type { Dispatcher } from '../../ports/dispatcher'
import type { RecoveryAction, RecoveryService, UnfinishedTurn } from '../../ports/runtime'
import { readRecoveryMarker } from '../../ports/runtime'
import type { SessionId, StoredEvent } from '../../ports/session'
import type { SessionService } from '../session/session-service'
import { err, ok, type Result } from '../../shared/result'

/**
 * 未完成回合恢复（agent-runtime.md §7、D14-⑦/D16-③/D17-⑤）：
 * - 判定：**缺 `turn_end`** 的最后一个 `turn_start`（跨重启同样成立）；
 * - 不自动续跑：`resolve` 落一条 `state` 恢复标记，并按动作注入一条系统消息唤醒一轮；
 * - 三选 + 补全：`report`（汇报中断点）/ `continue`（从 plan 断点续做）/ `ignore`（忽略，只落标记）/ `complete`（补全被截断的回复）。
 */

export interface RecoveryServiceOptions {
  readonly sessions: SessionService
  readonly clock: Clock
  /** 唤醒一轮（注入系统消息 + drain）；失败不阻断标记落盘 */
  readonly wake: (input: { readonly projectId: ProjectId; readonly instanceId: InstanceId; readonly text: string }) => Promise<void>
  /** 项目内全部会话 id（列表用；来自 SessionService.list） */
  readonly projectSessions: (projectId: ProjectId) => Promise<Result<readonly { readonly sessionId: SessionId; readonly instanceId: InstanceId }[]>>
  readonly dispatcher?: Pick<Dispatcher, 'drain'>
}

const ACTION_TEXT: Record<RecoveryAction, string> = {
  report:
    '上一回合（turn {turn}）被中断。请先用文字汇报：中断点在哪、已经完成什么、下一步打算做什么——**不要直接继续执行**。',
  continue:
    '上一回合（turn {turn}）被中断。请读取最近的 plan 事件，从中断处**继续执行**剩余步骤，并说明你从哪一步接着做。',
  complete: '你上一次回复被中断，文本不完整。请把上一段回复**补全**（不要重复已经输出的部分）。',
  ignore: '',
}

export function createRecoveryService(options: RecoveryServiceOptions): RecoveryService {
  const { sessions } = options

  const inspect = (events: readonly StoredEvent[]): UnfinishedTurn | null => {
    const resolved = new Map<number, RecoveryAction>()
    for (const event of events) {
      const marker = readRecoveryMarker(event)
      if (marker !== null) resolved.set(marker.turn, marker.action)
    }

    // 逐个回合跟踪"开/闭"（跨重启同样成立：缺 turn_end 即仍开着）。
    // 用**栈**按事件顺序配对：`turn_end` 关闭"最近的同号 turn_start"，因此即使回合号被复用
    // （如 runtime.state 丢失后从 1 重新计数），较早那个未闭合的回合仍能被判定出来。
    const open: { start: StoredEvent; plan: { steps: number; status: string | null } | null }[] = []
    for (const event of events) {
      if (event.kind === 'turn_start') {
        const steps = event.payload['steps']
        open.push({
          start: event,
          plan: Array.isArray(steps)
            ? {
                steps: steps.length,
                status: typeof event.payload['status'] === 'string' ? (event.payload['status'] as string) : null,
              }
            : null,
        })
        continue
      }
      if (event.kind === 'turn_end') {
        for (let index = open.length - 1; index >= 0; index -= 1) {
          if (open[index]?.start.turn === event.turn) {
            open.splice(index, 1)
            break
          }
        }
        continue
      }
      if (event.kind === 'plan') {
        for (let index = open.length - 1; index >= 0; index -= 1) {
          const current = open[index]
          if (current !== undefined && current.start.turn === event.turn) {
            const steps = event.payload['steps']
            current.plan = {
              steps: Array.isArray(steps) ? steps.length : (current.plan?.steps ?? 0),
              status: typeof event.payload['status'] === 'string' ? (event.payload['status'] as string) : null,
            }
            break
          }
        }
      }
    }
    if (open.length === 0) return null

    const entry = open[0]
    if (entry === undefined) return null
    const turn = entry.start.turn
    return {
      sessionId: entry.start.sessionId,
      instanceId: (typeof entry.start.payload['instanceId'] === 'string'
        ? (entry.start.payload['instanceId'] as string)
        : entry.start.sessionId.replace(/^u_/, '')) as InstanceId,
      turn,
      turnId: typeof entry.start.payload['turnId'] === 'string' ? (entry.start.payload['turnId'] as string) : null,
      startedAt: entry.start.ts,
      loopStep: typeof entry.start.payload['loopStep'] === 'string' ? (entry.start.payload['loopStep'] as string) : null,
      lastPlan: entry.plan,
      resolvedBy: resolved.get(turn) ?? null,
    }
  }

  return {
    async unfinished(projectId, sessionId) {
      const window = await sessions.window(projectId, sessionId)
      if (!window.ok) return window
      return ok(inspect(window.value))
    },

    async listUnfinished(projectId) {
      const listed = await options.projectSessions(projectId)
      if (!listed.ok) return listed
      const unfinished: UnfinishedTurn[] = []
      for (const session of listed.value) {
        const window = await sessions.window(projectId, session.sessionId)
        if (!window.ok) continue
        const found = inspect(window.value)
        if (found !== null) unfinished.push(found)
      }
      return ok(unfinished)
    },

    async resolve(input) {
      const current = await this.unfinished(input.projectId, input.sessionId)
      if (!current.ok) return current
      if (current.value === null) {
        return err('ERR_NOT_FOUND', '该会话没有未完成回合', { sessionId: input.sessionId })
      }
      if (current.value.turn !== input.turn) {
        return err('ERR_CONFLICT', `未完成回合不匹配（当前为 turn ${current.value.turn}）`, {
          expected: current.value.turn,
          received: input.turn,
        })
      }
      if (current.value.resolvedBy !== null) {
        return err('ERR_CONFLICT', `该未完成回合已按「${current.value.resolvedBy}」处理过`, {
          turn: current.value.turn,
          resolvedBy: current.value.resolvedBy,
        })
      }

      const marked = await sessions.append(input.projectId, input.sessionId, [
        {
          kind: 'state',
          turn: current.value.turn,
          payload: {
            unfinishedTurn: current.value.turn,
            recovery: input.action,
            at: options.clock.now().toISOString(),
          },
        },
      ])
      if (!marked.ok) return marked

      if (input.action === 'ignore') {
        return ok({ resumed: false, text: '已忽略该未完成回合（不再提示）' })
      }
      const text = ACTION_TEXT[input.action].replace('{turn}', String(current.value.turn))
      try {
        await options.wake({ projectId: input.projectId, instanceId: current.value.instanceId, text })
      } catch {
        // 唤醒失败不影响标记（用户可再次触发）
      }
      return ok({ resumed: true, text })
    },
  }
}
