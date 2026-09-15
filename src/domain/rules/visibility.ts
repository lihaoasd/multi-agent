import type { MemoryEntry } from '../../ports/memory'
import type { InstanceId } from '../../ports/project'
import type { SessionId } from '../../ports/session'
import type { Viewer } from '../../ports/viewer'

/**
 * 可见性规则（纯函数；D18-②「检索同等可见」）。
 * 同一份判定同时服务于：读取校验、`session_search`/`memory_search` 工具、HTTP 检索接口。
 */

export type { Viewer }

export interface MemoryVisibility {
  /** 是否可读项目全局记忆（所有 Agent 可读） */
  readonly global: boolean
  /** 可读的角色记忆归属（用户侧不受限时返回 null 表示"全部"） */
  readonly instanceIds: readonly InstanceId[] | null
  /** 可读的会话 id；null 表示不受限（用户） */
  readonly sessionIds: readonly SessionId[] | null
}

/** Agent 与用户各自的可见范围（memory.md §1） */
export function visibilityFor(viewer: Viewer): MemoryVisibility {
  if (viewer.kind === 'user') {
    return { global: true, instanceIds: null, sessionIds: null }
  }
  return { global: true, instanceIds: [viewer.instanceId], sessionIds: [`u_${viewer.instanceId}`] }
}

export function canReadSession(viewer: Viewer, sessionId: SessionId): boolean {
  const scope = visibilityFor(viewer).sessionIds
  return scope === null || scope.includes(sessionId)
}

export function canReadMemory(viewer: Viewer, entry: Pick<MemoryEntry, 'scope' | 'instanceId'>): boolean {
  const scope = visibilityFor(viewer)
  if (entry.scope === 'global') return scope.global
  return scope.instanceIds === null || (entry.instanceId !== null && scope.instanceIds.includes(entry.instanceId))
}

/** 过滤可见记忆条目（列表/检索共用） */
export function filterVisibleMemories(viewer: Viewer, entries: readonly MemoryEntry[]): readonly MemoryEntry[] {
  return entries.filter((entry) => canReadMemory(viewer, entry))
}
