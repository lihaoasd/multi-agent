import type { InstanceId } from './project'

/**
 * 访问者身份（纯数据，端口自有的最小公共类型）：
 * 用户（老板）不受限；Agent 只能触及"本人会话 ∪ 项目全局记忆 ∪ 本人角色记忆"（D18-②）。
 * 判定逻辑在 `domain/rules/visibility.ts`（纯函数），端口只承载形状。
 */
export type Viewer = { readonly kind: 'user' } | { readonly kind: 'agent'; readonly instanceId: InstanceId }
