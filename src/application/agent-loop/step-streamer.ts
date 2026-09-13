/**
 * 单步模型流（P3g 从 `loop-runner.ts` 抽出，2026-09-14）。
 *
 * 一次模型调用的**流式累积**：正文、思考（reasoning）、工具调用增量，
 * 并把正文/思考**实时**推给前端（`chunk` / `thought.chunk`）。
 *
 * 抽出的理由：这段逻辑只依赖"网关 + 事件总线 + 本轮标识"，与 runner 的回合状态机无关；
 * 独立后 runner 的回合编排更聚焦于"什么时候调、调完怎么处理"。
 * 行为逐字保持：累积顺序、推送时机、`tools` 为空时传 `undefined` 的细节都未改。
 */
import type { EventBus } from '../../infra/bus/event-bus.js'
import type { ChatMessage, ToolSchema } from '../../infra/model/provider.js'
import type { ModelGateway } from '../../infra/model/gateway.js'

/** 未完成的工具调用增量（按 index 累积）。 */
export interface StreamedToolCall {
  id?: string
  name?: string
  args: string
}

export interface StreamStepInput {
  gateway: ModelGateway
  bus: EventBus
  projectId: string
  sessionId: string
  turnId: string
  /** 发送方实例 id（推送里带上，前端据此归属到角色） */
  sender: string
  /** 模型路由：provider id（口径见 agent-runtime §5） */
  providerId: string
  messages: ChatMessage[]
  tools: ToolSchema[]
}

export interface StreamStepResult {
  stepText: string
  stepReasoning: string
  calls: Map<number, StreamedToolCall>
  finishReason?: string
}

/** 跑一步模型流：累积正文/思考/工具调用，并实时推 chunk（返回后由调用方落盘）。 */
export async function streamStep(input: StreamStepInput): Promise<StreamStepResult> {
  let stepText = ''
  let stepReasoning = ''
  let finishReason: string | undefined
  const calls = new Map<number, StreamedToolCall>()
  for await (const item of input.gateway.streamChat({
    providerId: input.providerId,
    messages: input.messages,
    tools: input.tools.length ? input.tools : undefined,
  })) {
    if (item.finishReason) finishReason = item.finishReason
    if (item.content) {
      stepText += item.content
      input.bus.emitChunk(input.projectId, input.sessionId, {
        turnId: input.turnId,
        delta: item.content,
        sender: input.sender,
      })
    }
    if (item.reasoning) {
      stepReasoning += item.reasoning
      input.bus.emitThoughtChunk(input.projectId, input.sessionId, {
        turnId: input.turnId,
        delta: item.reasoning,
        sender: input.sender,
      })
    }
    if (item.toolCall) {
      const cur = calls.get(item.toolCall.index) ?? { args: '' }
      if (item.toolCall.id) cur.id = item.toolCall.id
      if (item.toolCall.name) cur.name = item.toolCall.name
      if (item.toolCall.argumentsDelta) cur.args += item.toolCall.argumentsDelta
      calls.set(item.toolCall.index, cur)
    }
  }
  return { stepText, stepReasoning, calls, finishReason }
}
