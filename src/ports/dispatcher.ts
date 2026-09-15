import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 单工调度端口（真源：docs/design/agent-runtime.md §2/§7、abstraction.md §4.1/§4.3）。
 * 真相单轨（D18-④）：**occupancy 是运行期占用的唯一真相**；会话 meta 的 suspended 等只是派生投影。
 * 排队不引入独立队列：**队列 = 日志中 seq > lastHandledSeq 的未处理用户消息**（重启可重建）。
 */

export type AgentState = 'idle' | 'working' | 'waiting'

export interface OccupancyEntry {
  readonly type: 'user' | 'task'
  readonly sessionId: SessionId
  readonly since: string
}

export interface DispatcherState {
  readonly schemaVersion: 1
  readonly occupancy: Readonly<Record<InstanceId, OccupancyEntry>>
  /** per-agent 处理游标：已处理到的会话内 seq（重启后据此恢复排队处理） */
  readonly lastHandledSeq: Readonly<Record<InstanceId, number>>
  /** 暂停=不再领新活（D19-⑥），当前回合到可中断点挂起 */
  readonly paused: Readonly<Record<InstanceId, boolean>>
  /** 回合计数器（每个 Agent 单调递增，写入事件的 `turn` 字段） */
  readonly turns: Readonly<Record<InstanceId, number>>
}

export const EMPTY_DISPATCHER_STATE: DispatcherState = {
  schemaVersion: 1,
  occupancy: {},
  lastHandledSeq: {},
  paused: {},
  turns: {},
}

export interface DispatcherStateStore {
  load(projectId: ProjectId): Promise<Result<DispatcherState>>
  save(projectId: ProjectId, state: DispatcherState): Promise<Result<DispatcherState>>
}

/** 对外状态投影（左栏/画布用）：state 是派生值，occupancy 是真相 */
export interface AgentStatus {
  readonly instanceId: InstanceId
  readonly enabled: boolean
  readonly state: AgentState
  readonly paused: boolean
  readonly sessionId: SessionId | null
  /** 队列中未处理的消息条数（由日志与游标派生） */
  readonly queued: number
}

export interface Dispatcher {
  /** 用户发消息：先落 `message`(role=user) 事件，再按单工规则派发或排队 */
  submitUserMessage(input: {
    readonly projectId: ProjectId
    readonly sessionId: SessionId
    readonly text: string;
  }): Promise<Result<{ readonly seq: number; readonly queued: boolean }>>
  /** 处理该 Agent 的全部待处理消息（幂等；占用中直接返回） */
  drain(projectId: ProjectId, instanceId: InstanceId): Promise<Result<{ readonly handled: number }>>
  /** 状态投影（含 enabled，来自项目团队配置） */
  status(projectId: ProjectId): Promise<Result<readonly AgentStatus[]>>
  /** 恢复：重启后对"队列非空且无占用"的 Agent 补一轮（D18-③；不续跑缺 turn_end 的回合） */
  resumeQueued(projectId: ProjectId): Promise<Result<{ readonly resumed: readonly InstanceId[] }>>
  setPaused(projectId: ProjectId, instanceId: InstanceId, paused: boolean): Promise<Result<AgentStatus>>
  /**
   * 中断当前回合（"停止生成"与"停止任务"共用）：回合在可中断点结束、**游标不推进**（消息仍在队列）。
   * 返回是否真的中断了一个活动回合。
   */
  abortTurn(projectId: ProjectId, instanceId: InstanceId): boolean
  /** 启动时清掉进程崩溃遗留的占用（进程重启后不可能还有活跃回合）；返回清理条数 */
  resetStaleOccupancy(projectId: ProjectId): Promise<Result<number>>
}
