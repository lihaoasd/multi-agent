import type { Result } from '../shared/result'
import type { ModelId } from './model'

/**
 * Agent 模板端口（真源：docs/design/agent-templates.md §3/§4、data-storage.md §8）。
 * 本轮（FR-35）开放可配置三项：`systemPrompt` / `defaultLoop` / `defaultModel`；
 * `packages`/`tools` 等仍只读（U9 剩余）。
 */

export type RoleId = string
export type LoopStrategyName = string
export type ScenarioId = string

export interface LoopConfig {
  readonly strategy: LoopStrategyName
  readonly params: Readonly<Record<string, unknown>>
}

/** loop 通用参数（model-config.md §8 #14 校验范围） */
export interface LoopParams {
  readonly maxIterations?: number
  readonly toolBudget?: number
  readonly stepModelOverride?: ModelId
  readonly interruptibleAfterStep?: boolean
}

export interface RoleTemplate {
  readonly roleId: RoleId
  readonly name: string
  readonly category: string
  readonly scenario: ScenarioId
  readonly description: string
  readonly systemPrompt: string
  readonly defaultModel: ModelId | null
  readonly defaultLoop: LoopConfig
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly defaultApprovalRules: readonly string[]
  /** builtin=随仓库只读；user=用户"基于内置复制新建" */
  readonly source: 'builtin' | 'user'
  readonly enabled: boolean
  /** 复制来源（内置 roleId），用于溯源 */
  readonly copyFrom?: string
}

/** 本轮允许提交的字段（其余字段只读，见 agent-templates.md §4） */
export interface RoleTemplatePatch {
  readonly systemPrompt?: string
  readonly defaultLoop?: LoopConfig
  readonly defaultModel?: ModelId | null
}

export interface RoleTemplateCreateInput {
  readonly roleId: RoleId
  readonly copyFrom: RoleId
  readonly name?: string
  readonly scenario?: ScenarioId
  readonly systemPrompt?: string
  readonly defaultLoop?: LoopConfig
  readonly defaultModel?: ModelId | null
}

export interface RoleTemplateStore {
  /** 内置 + 用户模板（用户同名覆盖内置的情形不存在：须用新 roleId） */
  list(): Promise<Result<readonly RoleTemplate[]>>
  get(roleId: RoleId): Promise<Result<RoleTemplate>>
  create(input: RoleTemplateCreateInput): Promise<Result<RoleTemplate>>
  update(roleId: RoleId, patch: RoleTemplatePatch): Promise<Result<RoleTemplate>>
  setEnabled(roleId: RoleId, enabled: boolean): Promise<Result<RoleTemplate>>
  /** 配置历史快照（只增不改）；返回写入的相对路径 */
  appendHistory(roleId: RoleId, template: RoleTemplate): Promise<Result<string>>
  listHistory(roleId: RoleId): Promise<readonly string[]>
}
