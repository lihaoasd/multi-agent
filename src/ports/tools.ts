import type { Result } from '../shared/result'
import type { RootScheme } from './path-resolver'
import type { PolicyAction } from './policy'
import type { InstanceId, ProjectId } from './project'
import type { SessionType } from './session'

/**
 * 工具端口（真源：docs/design/tools.md §2/§3、abstraction.md §4.6）。
 * 每个工具声明能力与风险；执行一律经 `ToolExecutor` 的校验链（白名单 → 会话类型 → 策略 → 边界 → 审批 → 审计）。
 */

export type ToolName = string
export type PackageId = string
export type ToolScope = 'workdir' | 'readonly-global' | 'platform'
export type ToolRisk = 'none' | 'low' | 'high'
export type ToolNetwork = 'none' | 'allowed' | 'outbound_high'

export interface ToolDefinition {
  readonly name: ToolName
  readonly package: PackageId
  readonly description: string
  /** JSON Schema（透传给模型作为 function 定义） */
  readonly paramsSchema: Readonly<Record<string, unknown>>
  readonly scope: ToolScope
  readonly risk: ToolRisk
  readonly network: ToolNetwork
  /** 命中审批的策略来源之一（PolicyEngine 以此为数据源） */
  readonly needsApproval?: boolean
  readonly idempotent: boolean
  readonly availableIn: readonly SessionType[]
  readonly allowedRoots: readonly RootScheme[]
  readonly output: { readonly maxChars: number; readonly strategy: 'truncate-tail' | 'summarize' | 'raw' }
  /**
   * 把调用参数映射成策略输入（如 `cmd_run` → `{kind:'command', program, args}`）。
   * 缺省视为 `{kind:'tool'}`；返回 null 表示参数非法（执行前直接拒绝）。
   */
  readonly policyAction?: (input: unknown) => PolicyAction | null
}

export interface ToolCall {
  readonly callId: string
  readonly name: ToolName
  readonly args: unknown
}

/** 每次工具调用的上下文（由 loop 组装；实例配置以参数出现，不进容器） */
export interface ToolCallContext {
  readonly projectId: ProjectId
  readonly instanceId: InstanceId
  readonly sessionId: string
  readonly sessionType: SessionType
  readonly turn: number
  /** 触发本次工具调用的会话事件 seq（记忆条目溯源用；缺省 0 表示无锚点） */
  readonly sourceSeq?: number
  /** 项目工作目录/运行时目录（绝对路径） */
  readonly roots: import('./path-resolver').PathRoots
  /** 注入当前回合的审批等待回调（审批桥用）；返回决定与审批 id（供产出物记录 approvalId） */
  readonly requestApproval: (request: {
    readonly kind: 'command' | 'submit' | 'rollback'
    readonly summary: string
    readonly detail: string
  }) => Promise<Result<{ readonly decision: 'approved' | 'rejected'; readonly approvalId: string | null }>>
  /** 本次调用关联的审批 id（审批通过后由执行链填入） */
  readonly approvalId?: string | null
  /** 注入询问桥（`ask_user` 用）：落问题 + 等用户答复；缺省时该工具不可用 */
  readonly askUser?: (request: {
    readonly title: string
    readonly items: readonly {
      readonly text: string
      readonly options?: readonly string[]
      readonly required?: boolean
    }[]
  }) => Promise<Result<{ readonly questionId: string; readonly answers: readonly { readonly itemId: string; readonly choice: string | null; readonly text: string | null }[] }>>
  /** 信号：用户停止/回合取消 */
  readonly signal: AbortSignal
}

export interface ToolOutcome {
  readonly ok: boolean
  /** 给模型看的文本结果（已按 output 策略截断） */
  readonly text: string
  /** 结构化补充（审计与 UI 用） */
  readonly data?: Readonly<Record<string, unknown>>
  /** 失败时的统一错误码（回注模型） */
  readonly errorCode?: string
}

export type ToolHandler = (input: unknown, context: ToolCallContext) => Promise<ToolOutcome>

export interface ToolRegistry {
  register(definition: ToolDefinition, handler: ToolHandler): void
  get(name: ToolName): { readonly definition: ToolDefinition; readonly handler: ToolHandler } | undefined
  list(filter?: {
    readonly package?: PackageId
    readonly availableIn?: SessionType
    readonly names?: readonly ToolName[]
  }): readonly ToolDefinition[]
  /** 模型可用的 function 定义（按白名单与会话类型过滤） */
  schemasFor(names: readonly ToolName[], sessionType: SessionType): readonly {
    readonly name: ToolName
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }[]
}

/** 工具包元数据（8 个基础包全员必选，D19-② / S13；包不参与运行期授权，仅角色工具白名单 × 会话类型生效） */
export interface ToolPackageInfo {
  readonly id: PackageId
  readonly name: string
  readonly description: string
  readonly tools: readonly ToolName[]
  readonly riskMax: ToolRisk
  readonly network: ToolNetwork
  readonly required: boolean
  readonly source: 'builtin' | 'custom'
}

export interface ToolPackageRegistry {
  list(): readonly ToolPackageInfo[]
  get(id: PackageId): ToolPackageInfo | undefined
}

export type ToolExecutionResult = Result<ToolOutcome>
