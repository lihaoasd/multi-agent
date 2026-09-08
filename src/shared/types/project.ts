/**
 * 数据模型类型（shared 层，纯类型无 IO）。
 * schema 对齐 data-storage.md §3 project.json v1。
 */

/** 团队内角色实例配置项（M1 启用；MVP 每模板至多 1 实例 D14-3） */
export interface TeamMemberConfig {
  /** 实例 id，如 pm_1 */
  instanceId: string
  roleTemplateId: string
  displayName: string
  /** 创建实例时快照模板默认值写入；null 表示沿用模板（D16-⑤） */
  prompt: string | null
  model: string
  loop: { strategy: string; params?: Record<string, unknown> }
  tools: string[] | null
  enabled: boolean
  createdAt: string
}

/** 两扇审批门（workspaces-artifacts.md §6 类型→门映射） */
export interface ArtifactPolicy {
  codeSubmitApproval: boolean
  docSubmitApproval: boolean
}

export interface ProjectConfig {
  schemaVersion: 1
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  /** 用户选定工作目录（绝对路径存记录；迁移换机由用户重设，见 data-storage §9） */
  workdir: string
  workdirKind: 'empty' | 'existing-repo'
  team: TeamMemberConfig[]
  artifactPolicy: ArtifactPolicy
  approvalPolicy: { highRiskCommands: boolean }
}
