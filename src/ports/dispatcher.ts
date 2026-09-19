import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 单工调度端口（真源：docs/design/agent-runtime.md §2/§7、abstraction.md §4.1/§4.3）。
 * 真相单轨（D18-④）：**occupancy 是运行期占用的唯一真相**；会话 meta 的 suspended 等只是派生投影。
 * 排队不引入独立队列：**队列 = 日志中 seq > lastHandledSeq 的未处理用户消息**（重启可重建）。
 */

export type AgentState = 'idle' | 'working' | 'waiting'

/**
 * 等待中的**具体原因**（S38/D41）：`waiting` 只说明"卡住了"，但界面要对用户说清在等什么——
 * `question`＝等用户答复询问（`ask_user`），`approval`＝等审批决定；非等待态为 `null`。
 */
export type AgentWaitingFor = 'question' | 'approval'

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
  /**
   * 读改写（在同一把项目锁内）：**避免陈旧快照覆盖**──
   * 回合内可能嵌套为其它 Agent 触发 drain（任务委派通知），若用外层捕获的整份 state 覆盖写，
   * 会丢掉内层刚写入的游标/占用（表现为重复处理同一条队列消息）。
   */
  update(
    projectId: ProjectId,
    mutate: (state: DispatcherState) => DispatcherState,
  ): Promise<Result<DispatcherState>>
}

/** 对外状态投影（左栏/画布用）：state 是派生值，occupancy 是真相 */
export interface AgentStatus {
  readonly instanceId: InstanceId
  readonly enabled: boolean
  readonly state: AgentState
  /** `state='waiting'` 时说明在等什么（S38/D41）；其余情况为 `null` */
  readonly waitingFor: AgentWaitingFor | null
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
  /**
   * 恢复：把"队列非空且无占用且未暂停"的 Agent **各排一次** `drain`（D18-③；S47/D50 起**不 await 回合**——
   * 补处理会真的跑回合、还可能卡在等答复上，逐个 await 会让第一个卡住的 Agent 挡住其它 Agent）。
   * 返回的是**已排**的实例列表（不保证已完成）。
   */
  resumeQueued(projectId: ProjectId): Promise<Result<{ readonly resumed: readonly InstanceId[] }>>
  /**
   * 暂停/恢复（D19-⑥、S37 修复）：暂停=不再领新活，并**立即中断**当前回合（可中断点收尾）。
   * 语义要点：中断信号在**取锁之前**送达（`drain` 持锁跑完整个队列，等锁释放再中断等于没停）；
   * 被中断的回合**游标不推进** → 该消息留在队列，恢复后补处理。
   */
  setPaused(projectId: ProjectId, instanceId: InstanceId, paused: boolean): Promise<Result<AgentStatus>>
  /**
   * 中断当前回合（"停止生成"与"停止任务"共用）：回合在可中断点收尾、**本条消息作废**（游标照常推进，
   * 不重放），剩余队列消息**不再自动续跑**（留给用户下次触发）。
   * 返回是否真的中断了一个活动回合。
   */
  abortTurn(projectId: ProjectId, instanceId: InstanceId): boolean
  /** 启动时清掉进程崩溃遗留的占用（进程重启后不可能还有活跃回合）；返回清理条数 */
  resetStaleOccupancy(projectId: ProjectId): Promise<Result<number>>
}
