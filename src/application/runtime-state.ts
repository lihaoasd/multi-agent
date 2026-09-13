/**
 * 角色运行态推导（**单点真相**，2026-09-12）。
 *
 * 用户反馈过"角色显示工作中，会话里却还有一张待回答的提问卡片"——根因是状态有两个推导来源：
 * `GET /agents` 用「有待批审批/待答提问 → waiting」，而 loop 回合开始无条件广播 `working`、
 * 回合结束只按 occupancy 广播。两处优先级不一致，只要"已有待答提问时又被唤醒一个回合"就会打架。
 *
 * 现在 HTTP 查询（`server/app.ts`）与 WS `agent.state`（`agent-loop/loop-runner.ts`）
 * 共用本文件的纯函数，保证任一处给出的状态都相同：
 *   disabled（停用）> meeting（会议中）> waiting（等你处理提问/审批）> working（工作中）> idle（空闲）
 *
 * `waiting` 的语义是"角色在等用户"，因此**压过 working**——它不该再被算作开工；
 * 会议中的角色则不受影响（在会成员仍显示「会议中」）。
 */
import type { AgentActivityType, AgentOccupancy } from './dispatcher/occupancy-store.js'

/** 角色运行态（UI 团队行徽标；D16-② 四态 + 停用）。 */
export type AgentRuntimeState = 'idle' | 'working' | 'meeting' | 'waiting' | 'disabled'

export interface AgentStateInput {
  /** 实例是否启用（停用优先） */
  enabled: boolean
  /** runtime.state.json 里的 occupancy（当前占用） */
  occupancy: AgentOccupancy | null
  /** 该角色是否有待批审批 */
  hasPendingApproval: boolean
  /** 该角色是否有待回答的提问 */
  hasPendingQuestion: boolean
}

/** 状态推导（纯函数）：停用 > 会议 > 等待用户 > 工作 > 空闲。 */
export function deriveAgentState(input: AgentStateInput): AgentRuntimeState {
  if (!input.enabled) return 'disabled'
  const activity: AgentActivityType | null = input.occupancy?.activity ?? null
  if (activity === 'meeting') return 'meeting'
  if (input.hasPendingApproval || input.hasPendingQuestion) return 'waiting'
  if (activity === 'working') return 'working'
  return 'idle'
}
