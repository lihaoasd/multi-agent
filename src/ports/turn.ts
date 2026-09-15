import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'
import type { NewEvent, SessionId, SessionType, StoredEvent } from './session'

/**
 * 回合执行端口（abstraction.md §4.6 的 TurnContext/TurnRunner 精简版）。
 * S3 只定义"如何被调用"与"如何回写事件"；真正的 loop（策略、工具、上下文组装）在 S4 实现。
 */
export interface TurnRunContext {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly instanceId: InstanceId
  readonly sessionType: SessionType
  readonly turn: number
  readonly userText: string
  readonly signal: AbortSignal
  /** 写事件：由 dispatcher 保证**先落盘再推送**；返回落盘后的事件（含 seq） */
  readonly emit: (event: NewEvent) => Promise<Result<StoredEvent>>
}

export interface TurnRunner {
  /** 执行一个回合；失败以 Result 返回（dispatcher 落 `error` 事件并释放占用） */
  runTurn(context: TurnRunContext): Promise<Result<void>>
}
