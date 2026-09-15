/**
 * 统一策略引擎端口（真源：docs/design/sandbox.md §5.1、abstraction.md §4.4、D18-⑥）。
 * 输入事实（工具元数据 / 命令风险 / 项目策略 / 信任开关）→ 输出判定；**优先级 deny > approval > allow**。
 * 纯函数实现（domain/rules/policy.ts），不碰 IO。
 */
import type { InstanceId, ProjectId } from './project'
import type { SessionType } from './session'
import type { ArtifactType } from '../shared/artifacts'
import type { ToolName, ToolNetwork, ToolRisk } from './tools'

export interface Actor {
  readonly kind: 'agent' | 'user'
  readonly projectId: ProjectId
  readonly instanceId: InstanceId
}

export type PolicyAction =
  | {
      readonly kind: 'tool'
      readonly tool: ToolName
      readonly params: unknown
      readonly risk: ToolRisk
      readonly network: ToolNetwork
      readonly needsApproval: boolean
    }
  | {
      readonly kind: 'command'
      readonly program: string
      readonly args: readonly string[]
    }
  | {
      /** 产出物登记（workspaces-artifacts §6）：是否需审批由项目 `artifactPolicy` 决定 */
      readonly kind: 'submit'
      readonly tool: ToolName
      readonly artifactType: ArtifactType
      readonly risk: ToolRisk
      readonly network: ToolNetwork
      readonly needsApproval: boolean
    }

export interface TrustScope {
  /** 「同意并记住」：本会话内该角色 doc/test 提交直接通过（D17-④） */
  readonly sessionId: string
  readonly instanceId: InstanceId
  readonly allows: readonly string[]
}

export interface ProjectPolicy {
  readonly highRiskCommands: boolean
  readonly docSubmitApproval: boolean
  readonly codeSubmitApproval: boolean
  /** 联网开关（sandbox.md §6）：offline 时拒绝任何联网动作 */
  readonly network: 'online' | 'offline'
}

export interface PolicyInput {
  readonly actor: Actor
  readonly sessionType: SessionType
  readonly action: PolicyAction
  readonly projectPolicy: ProjectPolicy
  readonly trust?: TrustScope
}

export type PolicyDecision = 'allow' | 'approval' | 'deny'

export interface PolicyOutcome {
  readonly decision: PolicyDecision
  readonly ruleId: string
  readonly reason: string
}

export interface PolicyEngine {
  decide(input: PolicyInput): PolicyOutcome
}
