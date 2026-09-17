import type { Result } from '../shared/result'
import type { AgentState } from './dispatcher'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 运行控制与导出端口（真源：docs/design/agent-runtime.md §7、D14-⑦/D16-③/D17-⑤⑥）。
 * - **停止**：`turn`=停当前回合输出（队列保留）、`task`=终止当前任务（未结算改动先结算为 code artifact）；
 * - **细条**：`working` 只列非 idle 的 Agent（占用者 + 当前任务 + 最近 plan 状态 + 队列）。
 *
 * ⚠️ **2026-09-16（S21/D27）**：本端口**不再包含未完成回合的判定与恢复**——"上一回合是否收尾"
 * 由 Agent 自己查会话事件（工具 `session_recent`）判断，并自行用 `ask_user` 询问用户；
 * 平台既不检测也不给固定选项（原 `RecoveryAction`/`UnfinishedTurn`/`RecoveryService` 已删除）。
 */

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
