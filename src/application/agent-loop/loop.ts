import type { ChatMessage, ModelChunk, ToolSchema } from '../../ports/model'
import type { ServerEvent } from '../../ports/events'
import type { NewEvent, SessionId, StoredEvent } from '../../ports/session'
import type { ToolCall, ToolOutcome } from '../../ports/tools'
import type { Result } from '../../shared/result'
import type { ProjectId } from '../../ports/project'

/**
 * agent loop 策略扩展点（agent-runtime.md §3、abstraction.md §4.6）。
 * 策略只做"步骤编排"：模型调用、工具执行、事件写出都由 `LoopRunEnv` 提供的能力完成。
 */

export interface ModelTurnResult {
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly ToolCall[]
  readonly modelId: string | null
}

export interface LoopModelRequest {
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolSchema[]
  readonly modelOverride?: string
  readonly purpose: string
}

export interface LoopRunEnv {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly instanceId: string
  readonly turn: number
  readonly userText: string
  readonly systemPrompt: string
  /** 组装好的上下文消息（system + 历史窗口），策略在此之上追加指令 */
  readonly contextMessages: readonly ChatMessage[]
  /** 会话历史（已按上下文上限裁剪的 message 事件） */
  readonly history: readonly StoredEvent[]
  readonly toolSchemas: readonly ToolSchema[]
  /** 策略可用的工具名白名单（来自实例快照 ∩ 注册表） */
  readonly toolNames: readonly string[]
  readonly maxIterations: number
  readonly toolBudget: number
  readonly stepModelOverride?: string
  readonly signal: AbortSignal
  /** 写事件（先落盘后推送，由 dispatcher 保证） */
  readonly emit: (event: NewEvent) => Promise<Result<StoredEvent>>
  /** 只推送不落盘（流式增量等临时态，D14-⑦） */
  readonly notify: (event: ServerEvent) => void
  /** 调模型（内部含重试与流式归一化） */
  readonly callModel: (request: LoopModelRequest) => Promise<Result<ModelTurnResult>>
  /** 调工具（含策略校验链与审批桥） */
  readonly runTool: (call: ToolCall) => Promise<Result<ToolOutcome>>
  /** 工具预算计数（跨步骤共享） */
  readonly budget: { used(): number; spend(count?: number): void }
  /** 可中断点检查：暂停/停止请求在此生效 */
  readonly shouldInterrupt: () => boolean
}

export interface AgentLoopStrategy {
  readonly name: string
  readonly description: string
  run(env: LoopRunEnv): Promise<Result<void>>
}

export interface LoopRegistry {
  register(strategy: AgentLoopStrategy): void
  get(name: string): AgentLoopStrategy | undefined
  list(): readonly { readonly name: string; readonly description: string }[]
}

export function createLoopRegistry(): LoopRegistry {
  const strategies = new Map<string, AgentLoopStrategy>()
  return {
    register(strategy: AgentLoopStrategy): void {
      if (strategies.has(strategy.name)) {
        throw new Error(`ERR_INTERNAL: loop 策略重复注册：${strategy.name}`)
      }
      strategies.set(strategy.name, strategy)
    },
    get(name: string): AgentLoopStrategy | undefined {
      return strategies.get(name)
    },
    list(): readonly { readonly name: string; readonly description: string }[] {
      return [...strategies.values()].map((strategy) => ({
        name: strategy.name,
        description: strategy.description,
      }))
    },
  }
}

/** 把模型流归一化结果里的工具调用转成 `ToolCall`（统一 callId 缺失时的兜底） */
export function normalizeToolCall(call: { callId: string; name: string; args: unknown }, index: number): ToolCall {
  return {
    callId: call.callId.length > 0 ? call.callId : `call_${index}`,
    name: call.name,
    args: call.args ?? {},
  }
}

export type { ModelChunk }
