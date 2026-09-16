import type { ModelId } from '../../ports/model'
import type { RoleInstance } from '../../ports/project'
import type { LoopConfig } from '../../ports/role-templates'

/**
 * 有效配置解析（abstraction.md §4.4/§5.5）：
 * `实例覆盖 → 模板快照`；两级都没有模型即 `null`（回合报 `ERR_MODEL`）。
 * ⚠️ S14 起**不再有平台默认模型**（原 `routing.defaultModelId` 已随「默认路由」功能删除）。
 * ⚠️ 结果作为**参数**传给回合执行（TurnContext.config），不进容器。
 */
export interface EffectiveAgentConfig {
  readonly instanceId: string
  readonly roleTemplateId: string
  readonly displayName: string
  readonly enabled: boolean
  readonly systemPrompt: string
  readonly model: ModelId | null
  readonly loop: LoopConfig
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly approvalRules: readonly string[]
}

export function resolveEffectiveAgentConfig(instance: RoleInstance): EffectiveAgentConfig {
  return {
    instanceId: instance.instanceId,
    roleTemplateId: instance.roleTemplateId,
    displayName: instance.displayName,
    enabled: instance.enabled,
    // 提示词：实例覆盖整段替换快照（不是拼接；平台注入段由 ContextBuilder 运行期追加）
    systemPrompt: instance.prompt ?? instance.snapshot.systemPrompt,
    model: instance.model ?? instance.snapshot.defaultModel ?? null,
    loop: instance.loop ?? instance.snapshot.defaultLoop,
    packages: instance.snapshot.packages,
    tools: instance.snapshot.tools,
    artifactTypes: instance.snapshot.artifactTypes,
    approvalRules: instance.snapshot.defaultApprovalRules,
  }
}

/** 被实例显式覆盖的字段（UI 展示"哪些是自定义的"） */
export function describeInstanceOverrides(instance: RoleInstance): readonly string[] {
  const overrides: string[] = []
  if (instance.prompt !== null) overrides.push('prompt')
  if (instance.model !== null) overrides.push('model')
  if (instance.loop !== null) overrides.push('loop')
  return overrides
}
