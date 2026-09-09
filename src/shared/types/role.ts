/**
 * 角色模板模型（shared 类型，纯类型）。
 * 结构对齐 data-storage.md §8；值语义对齐 agent-runtime.md §1/§5、tools.md §4。
 */

/** agent loop 选择（模板默认值；实例可在项目内覆盖，D16-⑤ 快照） */
export interface LoopConfig {
  strategy: 'direct' | 'reflective' | 'plan-execute' | string
  params: Record<string, unknown>
}

/** 角色模板（系统库条目：内置只读 + 用户自建可写） */
export interface RoleTemplate {
  roleId: string
  name: string
  category: string
  description: string
  systemPrompt: string
  /** 引用 provider id（agent-runtime.md §5 口径：models.providers[].id） */
  defaultModel: string
  defaultLoop: LoopConfig
  /** 默认启用工具集（tools.md §4 角色矩阵；实例创建时快照） */
  tools: string[]
  artifactTypes: string[]
  defaultApprovalRules: Record<string, unknown>
  /** 来源标记：builtin=仓库内置（只读） / custom=用户自建（data/roles） */
  source: 'builtin' | 'custom'
  createdAt?: string
  updatedAt?: string
}

export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
