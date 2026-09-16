import type { ChatMessage, ModelChunk, ModelGateway, ModelInfo, ModelRequest } from '../src/ports/model'
import { ok, type Result } from '../src/shared/result'
import { createIdGenerator } from '../src/infra/util/id'

/**
 * 脚本化网关替身（测试/验收用）：按"未消费的剧本步骤"逐次返回文本与工具调用，
 * 让 prd §9 验收 1 的"Agent 沿出边委派 / 调工具 / 提问 / 汇报"能真正**经过 agent loop**跑通
 * （产品面已无任何假模型供应商，替身一律只存在于 tests/）。
 */

export interface ScriptStep {
  /** 仅当请求匹配时消费该步骤（缺省=任何请求都可消费） */
  readonly when?: (request: ModelRequest) => boolean
  readonly text?: string
  readonly toolCalls?: readonly { readonly name: string; readonly args: unknown }[]
}

export interface ScriptedGateway extends ModelGateway {
  /** 尚未消费的步骤数 */
  remaining(): number
  /** 已发生的调用次数（含汇总调用） */
  calls(): number
}

function lastUserText(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === 'user')
  return last?.content ?? ''
}

export function createScriptedGateway(steps: readonly ScriptStep[]): ScriptedGateway {
  const pending = [...steps]
  const ids = createIdGenerator()
  let calls = 0

  const pick = (request: ModelRequest): ScriptStep | undefined => {
    // 优先消费"带条件且匹配"的步骤；无条件的步骤只作为兜底，避免抢占其它 Agent 的剧本
    const guarded = pending.findIndex((step) => step.when !== undefined && step.when(request))
    const index = guarded >= 0 ? guarded : pending.findIndex((step) => step.when === undefined)
    if (index < 0) return undefined
    const [step] = pending.splice(index, 1)
    return step
  }

  const models: readonly ModelInfo[] = [
    { id: 'scripted', providerId: 'scripted', model: 'scripted', displayName: 'Scripted（替身）', capabilities: ['chat', 'stream', 'tools'], enabled: true },
  ]

  return {
    async stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
      calls += 1
      const step = pick(request)
      const chunks: ModelChunk[] = []
      if (step === undefined) {
        const text: ChatMessage['content'] = `[scripted] 收到：${lastUserText(request).slice(0, 80)}`
        chunks.push({ type: 'text-delta', text })
      } else {
        if (step.text !== undefined) chunks.push({ type: 'text-delta', text: step.text })
        for (const call of step.toolCalls ?? []) {
          chunks.push({ type: 'tool-call', callId: ids.next('call'), name: call.name, args: call.args })
        }
        if (step.text === undefined && (step.toolCalls ?? []).length === 0) {
          chunks.push({ type: 'text-delta', text: '[scripted] （空步骤）' })
        }
      }
      return ok(
        (async function* () {
          for (const chunk of chunks) yield chunk
        })(),
      )
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      return models
    },

    remaining: () => pending.length,
    calls: () => calls,
  }
}
