import { err, ok, type Result } from '../../shared/result'

/**
 * Agent 单工状态机（真源：docs/design/agent-runtime.md §2；三态 MVP，D16-②）。
 *
 *   idle --wake--> working --await--> waiting --resume--> working
 *                    |                    |
 *                    +------ settle ------+--> idle
 *
 * - `working` / `waiting` 均占用单工槽位（不变式：任一 Agent 至多一个活动会话）。
 * - `paused` 是**叠加开关**（D19-⑥ 暂停=不再领新活），不改变三态本身；
 *   暂停中 `wake` 被拒，其余流转（回合内收尾）照常，避免把 Agent 卡死。
 * - 非法流转统一 `ERR_CONFLICT`（无静默状态变更）。
 */
export type AgentState = 'idle' | 'working' | 'waiting'

export interface AgentRuntime {
  readonly state: AgentState
  readonly paused: boolean
}

export type AgentEvent =
  /** 被用户消息/任务唤醒：开始一个回合 */
  | { readonly type: 'wake' }
  /** 回合内等待用户输入/审批/询问答复 */
  | { readonly type: 'await' }
  /** 等待解除，回到工作中 */
  | { readonly type: 'resume' }
  /** 回合结束（正常收尾、终止、询问取消等） */
  | { readonly type: 'settle' }
  /** 暂停：不再领新任务 */
  | { readonly type: 'pause' }
  /** 恢复：可以继续领任务 */
  | { readonly type: 'unpause' }

export const IDLE_AGENT: AgentRuntime = { state: 'idle', paused: false }

/** 是否占用单工槽位（working/waiting 均占用，D11） */
export function isOccupied(runtime: AgentRuntime): boolean {
  return runtime.state !== 'idle'
}

/** 能否领取新任务：空闲且未暂停 */
export function canAcceptWork(runtime: AgentRuntime): boolean {
  return runtime.state === 'idle' && !runtime.paused
}

export function applyAgentEvent(current: AgentRuntime, event: AgentEvent): Result<AgentRuntime> {
  switch (event.type) {
    case 'pause':
      // 幂等：重复暂停不报错（运行控制允许重复点击）
      return ok(current.paused ? current : { ...current, paused: true })
    case 'unpause':
      return ok(current.paused ? { ...current, paused: false } : current)
    case 'wake': {
      if (current.paused) {
        return err('ERR_CONFLICT', '该 Agent 已暂停，不再领取新任务', { state: current.state })
      }
      if (current.state !== 'idle') {
        return err('ERR_CONFLICT', '该 Agent 已在处理活动回合（单工）', { state: current.state })
      }
      return ok({ ...current, state: 'working' })
    }
    case 'await': {
      if (current.state !== 'working') {
        return err('ERR_CONFLICT', '只有工作中的 Agent 可以进入等待', { state: current.state })
      }
      return ok({ ...current, state: 'waiting' })
    }
    case 'resume': {
      if (current.state !== 'waiting') {
        return err('ERR_CONFLICT', '该 Agent 当前不在等待状态', { state: current.state })
      }
      return ok({ ...current, state: 'working' })
    }
    case 'settle': {
      if (current.state === 'idle') {
        return err('ERR_CONFLICT', '该 Agent 没有进行中的回合', { state: current.state })
      }
      return ok({ ...current, state: 'idle' })
    }
  }
}
