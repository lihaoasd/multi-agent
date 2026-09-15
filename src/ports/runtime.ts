import type { Result } from '../shared/result'
import type { AgentState } from './dispatcher'
import type { InstanceId, ProjectId } from './project'
import type { SessionId, StoredEvent } from './session'

/**
 * 运行控制与恢复端口（真源：docs/design/agent-runtime.md §7、D14-⑦/D16-③/D17-⑤⑥）。
 * - **未完成回合**：以"缺 `turn_end`"为唯一判定依据（跨重启同样成立）；
 * - **不自动续跑**：恢复由用户三选驱动（汇报中断点 / 继续执行 / 忽略）+ 半截文本补全；
 * - **停止**：`turn`=停当前回合输出（队列保留）、`task`=终止当前任务（未结算改动先结算为 code artifact）。
 */

export type RecoveryAction = 'report' | 'continue' | 'ignore' | 'complete'

export interface UnfinishedTurn {
  readonly sessionId: SessionId
  readonly instanceId: InstanceId
  readonly turn: number
  readonly turnId: string | null
  readonly startedAt: string
  readonly loopStep: string | null
  /** 该回合最后一条 plan 事件的进度（S8 恢复剧本一致性用） */
  readonly lastPlan: { readonly steps: number; readonly status: string | null } | null
  /** 已恢复处理过的动作（null=尚未处理） */
  readonly resolvedBy: RecoveryAction | null
}

export interface RecoveryService {
  /** 某会话当前的未完成回合（无则 null） */
  unfinished(projectId: ProjectId, sessionId: SessionId): Promise<Result<UnfinishedTurn | null>>
  /** 项目内全部未完成回合（横幅与启动自检用） */
  listUnfinished(projectId: ProjectId): Promise<Result<readonly UnfinishedTurn[]>>
  /** 三选 + 补全：落恢复标记，并按动作向该 Agent 注入一条系统消息唤醒一轮 */
  resolve(input: {
    readonly projectId: ProjectId
    readonly sessionId: SessionId
    readonly turn: number
    readonly action: RecoveryAction
  }): Promise<Result<{ readonly resumed: boolean; readonly text: string }>>
}

export interface RuntimeAgentView {
  readonly instanceId: InstanceId
  readonly displayName: string
  readonly state: AgentState
  readonly paused: boolean
  readonly queued: number
  readonly sessionId: SessionId
  readonly turn: number
  readonly startedAt: string | null
  /** 当前激活任务标题（无则 null） */
  readonly taskTitle: string | null
  /** 最近一条 plan 事件的状态（与 plan 事件一致） */
  readonly planStatus: string | null
  readonly unfinishedTurn: number | null
}

export interface RuntimeSnapshot {
  readonly projectId: ProjectId
  /** 「n 个 Agent 正在工作」细条数据 */
  readonly working: readonly RuntimeAgentView[]
  readonly idle: number
  readonly paused: number
  readonly queuedTotal: number
}

export interface RuntimeService {
  snapshot(projectId: ProjectId): Promise<Result<RuntimeSnapshot>>
  /** 停止：`turn`=停当前回合输出（队列保留）；`task`=终止当前任务（先结算未结算改动） */
  stop(input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly scope: 'turn' | 'task'
  }): Promise<
    Result<{
      readonly aborted: boolean
      readonly taskId: string | null
      readonly settledArtifactId: string | null
      readonly queued: number
    }>
  >
}

/** 导出用的归档条目（文本内容；`path` 为相对项目数据目录的路径） */
export interface ArchiveEntry {
  readonly path: string
  readonly content: string
}

export interface ArchiveWriter {
  build(entries: readonly ArchiveEntry[]): Buffer
}

/** 项目数据导出（`GET /api/projects/:pid/export`）：把运行时项目文件夹打包为 zip */
export interface ProjectExporter {
  export(projectId: ProjectId): Promise<Result<{ readonly fileName: string; readonly bytes: number; readonly content: Buffer }>>
}

/** 供恢复服务判定：事件是否属于"已恢复处理"的标记（`state` 事件） */
export interface RecoveryMarker {
  readonly turn: number
  readonly action: RecoveryAction
  readonly at: string
}

export function readRecoveryMarker(event: StoredEvent): RecoveryMarker | null {
  if (event.kind !== 'state') return null
  const turn = event.payload['unfinishedTurn']
  const action = event.payload['recovery']
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return null
  if (action !== 'report' && action !== 'continue' && action !== 'ignore' && action !== 'complete') return null
  return { turn, action, at: event.ts }
}
