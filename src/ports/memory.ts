import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'
/**
 * 记忆端口（真源：docs/design/memory.md、data-storage.md §5、abstraction.md §4.1）。
 * 双层：`global`（项目共享）+ `agent`（角色长期记忆）。条目只增不物理删（可置 `superseded`）。
 */

export type MemoryScope = 'global' | 'agent'

/** `type` 全集（data-storage.md §5）；不得另起旁路词汇 */
export const MEMORY_TYPES = [
  'fact',
  'decision',
  'preference',
  'commitment',
  'requirement',
  'progress',
  'artifact_index',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemorySource {
  readonly sessionId: SessionId
  readonly seq: number
}

export interface MemoryEntry {
  readonly id: string
  readonly ts: string
  readonly scope: MemoryScope
  /** scope=agent 时必填 */
  readonly instanceId: InstanceId | null
  readonly type: MemoryType
  readonly content: string
  readonly source: MemorySource
  readonly tags: readonly string[]
  readonly refs: readonly string[]
  readonly state: 'active' | 'superseded'
  readonly supersededBy: string | null
}

export interface MemoryListFilter {
  readonly scope?: MemoryScope
  readonly instanceId?: InstanceId
  readonly type?: MemoryType
  readonly state?: 'active' | 'superseded'
  readonly limit?: number
}

export interface MemoryStore {
  append(projectId: ProjectId, entry: MemoryEntry): Promise<Result<MemoryEntry>>
  list(projectId: ProjectId, filter?: MemoryListFilter): Promise<Result<readonly MemoryEntry[]>>
  get(projectId: ProjectId, entryId: string): Promise<Result<MemoryEntry>>
  /** 标记旧条目被新条目取代（不物理删除：append-only 追加一条状态变更行） */
  supersede(projectId: ProjectId, entryId: string, supersededBy: string): Promise<Result<MemoryEntry>>
  /** 注入上下文用的激活条目（global + 指定实例），按时间倒序取前 N 条 */
  activeFor(
    projectId: ProjectId,
    input: { readonly instanceId: InstanceId; readonly globalLimit: number; readonly roleLimit: number },
  ): Promise<Result<readonly MemoryEntry[]>>
}

/** 全局记忆的写入白名单：只有"决策类"可由引擎写入（rule 6 口径） */
export const GLOBAL_MEMORY_TYPES: readonly MemoryType[] = ['decision', 'requirement', 'progress']

/** 追加记忆的入参（写路径用例的公共形状） */
export interface AppendMemoryInput {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  /** 溯源 seq（通常为触发写入的会话事件 seq） */
  readonly seq: number
  readonly type: MemoryType
  readonly content: string
  readonly tags?: readonly string[]
  readonly refs?: readonly string[]
}

/**
 * L3 记忆用例端口（实现见 `application/memory/memory-service.ts`）。
 * 工具（infra）只依赖本端口，不依赖 application（abstraction.md §2 分层）。
 */
export interface MemoryService {
  /** Agent 显式写入自己的角色记忆（工具 `memory_append` 走这里） */
  appendOwn(input: AppendMemoryInput & { readonly instanceId: InstanceId }): Promise<Result<MemoryEntry>>
  /** 全局记忆写入（引擎/用户确认路径；类型必须在白名单内） */
  recordGlobal(input: AppendMemoryInput): Promise<Result<MemoryEntry>>
  list(projectId: ProjectId, filter?: MemoryListFilter): Promise<Result<readonly MemoryEntry[]>>
  supersede(projectId: ProjectId, entryId: string, supersededBy: string): Promise<Result<MemoryEntry>>
  /** 注入上下文用的激活条目（global + 指定角色，上限取 `contextLimits`） */
  activeFor(projectId: ProjectId, instanceId: InstanceId): Promise<Result<readonly MemoryEntry[]>>
}
