import type { PolicyAction, PolicyEngine, ProjectPolicy } from '../../ports/policy'
import type { InstanceId, ProjectId } from '../../ports/project'
import type { PathRoots } from '../../ports/path-resolver'
import type { SessionType } from '../../ports/session'
import type { ToolCall, ToolOutcome, ToolRegistry } from '../../ports/tools'
import { err, ok, type Result } from '../../shared/result'

export interface ToolExecutionContext {
  readonly projectId: ProjectId
  readonly instanceId: InstanceId
  readonly sessionId: string
  readonly sessionType: SessionType
  readonly turn: number
  readonly roots: PathRoots
  readonly projectPolicy: ProjectPolicy
  readonly signal: AbortSignal
  /** 审批桥：由 loop 提供（落审批记录 + 发事件 + 等待用户决定） */
  readonly requestApproval: (request: {
    readonly kind: 'command' | 'submit' | 'rollback'
    readonly summary: string
    readonly detail: string
  }) => Promise<Result<'approved' | 'rejected'>>
}

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry
  readonly policy: PolicyEngine
}

export interface ToolExecutor {
  /** 校验链：注册 → 会话类型 → 策略（deny/approval）→ 执行（边界校验在工具内） */
  execute(call: ToolCall, context: ToolExecutionContext): Promise<Result<ToolOutcome>>
}

/** 工具校验链（tools.md §5 / D18-⑥）：策略只判定，审批与事件由 loop 负责落盘 */
export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return {
    async execute(call: ToolCall, context: ToolExecutionContext): Promise<Result<ToolOutcome>> {
      const entry = options.registry.get(call.name)
      if (entry === undefined) {
        return err('ERR_TOOL_REJECTED', `工具未注册或当前版本不可用：${call.name}`, { tool: call.name })
      }
      const { definition, handler } = entry
      if (!definition.availableIn.includes(context.sessionType)) {
        return err('ERR_TOOL_REJECTED', `工具 ${call.name} 不适用于该会话类型`, {
          tool: call.name,
          sessionType: context.sessionType,
        })
      }

      // policyAction 存在时必须尊重其返回值：null 表示参数非法（不能用 ?? 吞掉）
      let action: PolicyAction | null
      if (definition.policyAction !== undefined) {
        action = definition.policyAction(call.args)
      } else {
        action = {
          kind: 'tool',
          tool: call.name,
          params: call.args,
          risk: definition.risk,
          network: definition.network,
          needsApproval: definition.needsApproval === true,
        }
      }
      if (action === null) {
        return err('ERR_VALIDATION', `工具参数非法：${call.name}`)
      }

      const decision = options.policy.decide({
        actor: { kind: 'agent', projectId: context.projectId, instanceId: context.instanceId },
        sessionType: context.sessionType,
        action,
        projectPolicy: context.projectPolicy,
      })

      if (decision.decision === 'deny') {
        const code = decision.ruleId === 'NET_OFFLINE' ? 'ERR_NET_OFFLINE' : 'ERR_TOOL_REJECTED'
        return err(code, `策略拒绝：${decision.reason}`, { ruleId: decision.ruleId, tool: call.name })
      }

      if (decision.decision === 'approval') {
        const approved = await context.requestApproval({
          kind: action.kind === 'command' ? 'command' : 'submit',
          summary:
            action.kind === 'command'
              ? `执行命令：${action.program} ${action.args.join(' ')}`.trim()
              : `调用工具：${call.name}`,
          detail: `${decision.reason}（ruleId=${decision.ruleId}）\n参数：${JSON.stringify(call.args).slice(0, 800)}`,
        })
        if (!approved.ok) return approved
        if (approved.value === 'rejected') {
          return err('ERR_APPROVAL_REJECTED', '用户拒绝了该动作，请调整方案', {
            tool: call.name,
            ruleId: decision.ruleId,
          })
        }
      }

      const outcome = await handler(call.args, {
        projectId: context.projectId,
        instanceId: context.instanceId,
        sessionId: context.sessionId,
        sessionType: context.sessionType,
        turn: context.turn,
        roots: context.roots,
        requestApproval: context.requestApproval,
        signal: context.signal,
      })

      // 输出兜底截断（工具自身已按 output 策略截断，这里防止实现遗漏）
      const maxChars = definition.output.maxChars
      return ok(
        outcome.text.length <= maxChars
          ? outcome
          : { ...outcome, text: `${outcome.text.slice(0, maxChars)}\n…（输出已截断）` },
      )
    },
  }
}
