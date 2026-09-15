import type { Result } from '../shared/result'
import type { ModelId } from './model'
import type { LoopConfig } from './role-templates'

/**
 * 项目与团队实例端口（真源：docs/design/data-storage.md §3）。
 * 快照口径（D16-⑤）：创建实例时把模板默认值快照进实例；此后模板变更**不影响**既有实例。
 */

export type ProjectId = string
export type InstanceId = string
export type WorkdirKind = 'empty' | 'existing-repo'

/** 实例创建时从模板捕获的只读快照 */
export interface RoleInstanceSnapshot {
  readonly roleTemplateId: string
  readonly templateName: string
  readonly systemPrompt: string
  readonly defaultModel: ModelId | null
  readonly defaultLoop: LoopConfig
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly defaultApprovalRules: readonly string[]
  readonly capturedAt: string
}

/** 项目内的角色实例（Agent）；`prompt`/`model`/`loop` 为**覆盖**，null = 用快照 */
export interface RoleInstance {
  readonly instanceId: InstanceId
  readonly roleTemplateId: string
  readonly displayName: string
  readonly prompt: string | null
  readonly model: ModelId | null
  readonly loop: LoopConfig | null
  readonly enabled: boolean
  /** 配置版本：每次覆盖 +1（供 S4 的解析缓存失效与审计） */
  readonly configVersion: number
  readonly createdAt: string
  readonly snapshot: RoleInstanceSnapshot
}

export interface ArtifactPolicy {
  readonly codeSubmitApproval: boolean
  readonly docSubmitApproval: boolean
}

export interface ApprovalPolicy {
  readonly highRiskCommands: boolean
}

export interface ProjectMeta {
  readonly schemaVersion: 1
  readonly id: ProjectId
  readonly name: string
  readonly description: string
  readonly createdAt: string
  readonly updatedAt: string
  /** 用户选定的项目工作目录（绝对路径；产出物唯一落地处） */
  readonly workdir: string
  readonly workdirKind: WorkdirKind
  readonly team: readonly RoleInstance[]
  readonly artifactPolicy: ArtifactPolicy
  readonly approvalPolicy: ApprovalPolicy
}

export interface ProjectSummary {
  readonly id: ProjectId
  readonly name: string
  readonly description: string
  readonly workdir: string
  readonly workdirKind: WorkdirKind
  readonly createdAt: string
  readonly updatedAt: string
  readonly memberCount: number
  readonly enabledCount: number
}

export interface ProjectStore {
  /** 列表（扫描 project.json 为真源，index.json 仅作投影缓存） */
  list(): Promise<Result<readonly ProjectSummary[]>>
  get(id: ProjectId): Promise<Result<ProjectMeta>>
  create(meta: ProjectMeta): Promise<Result<ProjectMeta>>
  /** 读改写串行（实现内部用 LockManager），失败语义：不存在 → ERR_NOT_FOUND */
  update(id: ProjectId, mutate: (meta: ProjectMeta) => Result<ProjectMeta>): Promise<Result<ProjectMeta>>
  /** 只删平台运行时数据，不动用户工作目录（prd FR-01） */
  remove(id: ProjectId): Promise<Result<void>>
}
