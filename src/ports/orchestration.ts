import type { Result } from '../shared/result'
import type { InstanceId, ProjectId } from './project'

/**
 * 编排图端口（真源：docs/design/orchestration.md §2/§3/§7）。
 * 图是**项目级**的：节点 = 项目实例；边 = "可以创建/委派任务"的有向关系（无自环、无重复）。
 * 保存为**全量提交** + `version` 乐观并发；冲突返回 `ERR_CONFLICT`。
 */

export interface OrchestrationNode {
  readonly instanceId: InstanceId
  readonly x: number
  readonly y: number
  readonly collapsed: boolean
}

export interface OrchestrationEdge {
  readonly id: string
  readonly from: InstanceId
  readonly to: InstanceId
  readonly createdAt: string
}

export interface OrchestrationGraph {
  readonly schemaVersion: 1
  readonly projectId: ProjectId
  /** 每次保存 +1（乐观并发：提交时带 version） */
  readonly version: number
  readonly updatedAt: string
  readonly updatedBy: string
  readonly nodes: readonly OrchestrationNode[]
  readonly edges: readonly OrchestrationEdge[]
}

export interface OrchestrationStore {
  /** 不存在 → 返回 `version=0` 的空图（不落盘） */
  load(projectId: ProjectId): Promise<Result<OrchestrationGraph>>
  /** 全量写入（内部按项目串行；调用方负责版本校验语义） */
  save(projectId: ProjectId, graph: OrchestrationGraph): Promise<Result<OrchestrationGraph>>
}

export interface SaveOrchestrationInput {
  readonly projectId: ProjectId
  readonly expectedVersion: number
  readonly nodes: readonly OrchestrationNode[]
  readonly edges: readonly { readonly id?: string; readonly from: InstanceId; readonly to: InstanceId }[]
  readonly updatedBy?: string
}

export interface OrchestrationService {
  /** 读取并按当前团队归一化（补新实例节点、级联删除已移除实例的节点与边；不落盘） */
  get(projectId: ProjectId): Promise<Result<OrchestrationGraph>>
  save(input: SaveOrchestrationInput): Promise<Result<OrchestrationGraph>>
  /** 某实例的直接出边目标（委派权限判定用，orchestration.md §1 铁律 2） */
  outgoingOf(projectId: ProjectId, from: InstanceId): Promise<Result<readonly InstanceId[]>>
  /** Agent 沿出边委派是否被允许（用户不受限，由调用方决定是否调用） */
  canDelegate(projectId: ProjectId, from: InstanceId, to: InstanceId): Promise<Result<boolean>>
}
