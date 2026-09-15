import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'

/**
 * 会话与事件端口（真源：docs/design/data-storage.md §4、abstraction.md §4.1/§4.6）。
 * 会话日志是**唯一真相源**：账本（meta）只是可重建投影；事件先落盘再推送（先盘后推）。
 */

export type SessionId = string
/** MVP 只有用户↔角色 1:1 会话；保留类型字段以便后续扩展 */
export type SessionType = 'user'
export type SessionState = 'active' | 'suspended' | 'archived'

/** `data-storage.md` §4.2 的事件 kind 全集（不得另起旁路词汇） */
export const EVENT_KINDS = [
  'turn_start',
  'turn_end',
  'plan',
  'message',
  'thought',
  'tool_call',
  'tool_result',
  'approval_request',
  'approval_result',
  'artifact',
  'state',
  'summary',
  'error',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

/** 事件载荷：key-value 直接平铺进日志行（与 data-storage §4.2 的 schema 一致） */
export type EventPayload = Readonly<Record<string, unknown>>

export interface NewEvent {
  readonly kind: EventKind
  readonly turn: number
  readonly payload: EventPayload
  /** 缺省由存储层补当前时间 */
  readonly ts?: string
}

export interface StoredEvent {
  readonly seq: number
  readonly ts: string
  readonly sessionId: SessionId
  readonly turn: number
  readonly kind: EventKind
  readonly payload: EventPayload
}

/** 轮转分段：seq 跨段仍单调连续（M3 定稿） */
export interface SegmentRef {
  readonly file: string
  readonly startSeq: number
  readonly endSeq: number
  /** 该段已写入行数（用于轮转判定；实现补充字段） */
  readonly lines: number
}

export interface SummaryRef {
  readonly seq: number
  readonly summaryId: string
  readonly ofSeq: number
  readonly toSeq: number
}

export interface SessionMeta {
  readonly schemaVersion: 1
  readonly id: SessionId
  readonly type: SessionType
  readonly projectId: ProjectId
  readonly participants: { readonly user: true; readonly agents: readonly InstanceId[] }
  /** `active` 为真相；`suspended/archived` 由 occupancy/实例停用派生（D18-④） */
  readonly state: SessionState
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly lastSeq: number
  readonly segments: readonly SegmentRef[]
  readonly summaryRefs: readonly SummaryRef[]
}

export interface SessionMetaStore {
  list(projectId: ProjectId): Promise<Result<readonly SessionMeta[]>>
  get(projectId: ProjectId, sessionId: SessionId): Promise<Result<SessionMeta>>
  create(meta: SessionMeta): Promise<Result<SessionMeta>>
  update(
    projectId: ProjectId,
    sessionId: SessionId,
    mutate: (meta: SessionMeta) => Result<SessionMeta>,
  ): Promise<Result<SessionMeta>>
}

export interface ReadWindowOptions {
  readonly fromSeq?: number
  readonly limit?: number
}

/**
 * 会话日志端口。
 * ⚠️ 与 abstraction.md §4.6 的签名相比**多了 `projectId`**：会话文件本就位于项目目录内
 * （`projects/<pid>/sessions/`），带上项目 id 可避免为定位文件而全盘扫描（实现口径，2026-09-15）。
 */
export interface SessionLogStore {
  /** 追加事件并**分配连续 seq**（原子；先落盘，调用方随后 publish） */
  append(projectId: ProjectId, sessionId: SessionId, events: readonly NewEvent[]): Promise<Result<readonly StoredEvent[]>>
  readWindow(
    projectId: ProjectId,
    sessionId: SessionId,
    opts?: ReadWindowOptions,
  ): Promise<Result<readonly StoredEvent[]>>
  readKinds(
    projectId: ProjectId,
    sessionId: SessionId,
    kinds: readonly EventKind[],
    opts?: ReadWindowOptions,
  ): Promise<Result<readonly StoredEvent[]>>
  lastSeq(projectId: ProjectId, sessionId: SessionId): Promise<number>
  /** 超阈值轮转；返回更新后的分段表（seq 跨段仍单调） */
  rotate(
    projectId: ProjectId,
    sessionId: SessionId,
    maxLinesPerSegment: number,
  ): Promise<Result<readonly SegmentRef[]>>
}

/** 会话在 UI 上的摘要（左栏会话切换用） */
export interface SessionSummary {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly instanceId: InstanceId
  readonly displayName: string
  readonly state: SessionState
  readonly lastSeq: number
  readonly updatedAt: string
  readonly lastMessagePreview: string | null
}
