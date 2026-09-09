/**
 * 会话与事件模型（shared 类型，纯类型）。
 * 对齐 data-storage.md §4（meta.json + log.jsonl 事件 schema、单一事件规范 D18-⑤d）。
 */

export type SessionType = 'user' | 'meeting'

/** user 会话状态（suspended 为 occupancy 派生投影，M3+ 由 dispatcher 重算，meta 仅缓存） */
export type UserSessionState = 'active' | 'suspended' | 'archived'
/** meeting 会话状态（D16-①，全量落盘） */
export type MeetingSessionState = 'queued' | 'proposed' | 'open' | 'blocked_waiting_user' | 'closed'

/** 会话 meta（data-storage §4.1） */
export interface SessionMeta {
  id: string
  type: SessionType
  projectId: string
  participants: { user: boolean; agents: string[] }
  host: string | null
  /** user: active|suspended|archived；meeting: queued|proposed|open|blocked_waiting_user|closed */
  state: UserSessionState | MeetingSessionState
  agenda: unknown
  createdAt: string
  updatedAt: string
  closedAt: string | null
  /** log 已写到的最大 seq（跨轮转仍单调） */
  lastSeq: number
  /** 轮转分段表（M3；M2 恒为单个文件） */
  segments: Array<{ file: string; startSeq: number; endSeq: number }>
  /** 摘要行索引（M5） */
  summaryRefs: Array<{ seq: number; summaryId: string; ofSeq: number; toSeq: number }>
  [k: string]: unknown
}

/** 会话事件 kind 全集（data-storage §4.2） */
export const EventKinds = [
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
  'meeting_event',
  'state',
  'summary',
  'error',
] as const
export type EventKind = (typeof EventKinds)[number]

/** 会话 log 单条事件（与 UI 投影、索引共用同一规范事件，D18-⑤d） */
export interface SessionLogEvent {
  seq: number
  ts: string
  sessionId: string
  /** 所属 Agent 回合序号；用户消息/系统事件可缺省 */
  turn?: number | null
  kind: EventKind
  /** 可见消息/推理文本（message/thought） */
  content?: { text: string; blocks?: unknown[] }
  role?: 'user' | 'agent' | 'system'
  sender?: string
  model?: string
  /** 结构化负载（turn/plan/tool/approval/artifact/meeting/summary/state/error） */
  payload?: Record<string, unknown>
}

/** 下行 WS 事件（api/contract §3，UI 投影；与 log kind 一一对应） */
export interface WsEvent {
  type: string
  projectId?: string
  sessionId?: string
  payload?: Record<string, unknown>
}
