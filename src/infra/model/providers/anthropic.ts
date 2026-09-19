import type { ChatMessage, ModelChunk, ModelRequest } from '../../../ports/model'
import type { ModelProviderConfig, ProviderKindAdapter, ProviderTestResult, ResolvedModel } from '../../../ports/model-config'
import { err, ok, type Result } from '../../../shared/result'
import { requestJson, requestStream } from '../http'
import { asArray, asNumber, asRecord, asString, get, joinUrl, parseToolArgs } from '../json'
import { iterateSse } from '../stream'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './openai-compatible'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

function timeoutOf(provider: ModelProviderConfig): number {
  return provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return {
    ...(apiKey === null ? {} : { 'x-api-key': apiKey }),
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

function buildMessages(messages: readonly ChatMessage[]): {
  system: string | undefined
  others: readonly Record<string, unknown>[]
} {
  const systemParts: string[] = []
  const others: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      others.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            ...(message.toolCallId === undefined ? {} : { tool_use_id: message.toolCallId }),
            content: message.content,
          },
        ],
      })
      continue
    }
    others.push({ role: message.role, content: message.content })
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, others }
}

function buildBody(resolved: ResolvedModel, request: ModelRequest): Record<string, unknown> {
  const { system, others } = buildMessages(request.messages)
  const temperature = request.temperature ?? resolved.entry.defaultParams?.temperature
  const maxTokens =
    request.maxTokens ??
    resolved.entry.defaultParams?.maxTokens ??
    resolved.entry.maxOutputTokens ??
    DEFAULT_MAX_TOKENS
  /**
   * 思考（S40/D43）：Anthropic 的 `thinking` 要求 `max_tokens > budget_tokens`，
   * 且**带工具调用时**必须把上一轮的 thinking block（含 signature）原样回传，否则会被拒。
   * 本平台尚未保存 signature，因此**只在本次请求不带 tools 时**启用思考，避免 400
   * （完整支持＝保存 signature 并随 assistant 消息回传，记在遗留里）。
   */
  const wantsThinking = resolved.entry.capabilities.includes('reasoning')
  const hasTools = request.tools !== undefined && request.tools.length > 0
  const budget = Math.min(resolved.entry.defaultParams?.thinkingBudget ?? 4096, maxTokens - 1024)
  const thinkingEnabled = wantsThinking && !hasTools && budget >= 1024
  return {
    model: resolved.entry.model,
    max_tokens: maxTokens,
    stream: true,
    messages: others,
    ...(system === undefined ? {} : { system }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(thinkingEnabled ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }),
  }
}

/** 命名 SSE 事件：content_block_delta(text_delta/input_json_delta) + message_delta(usage) */
async function* parseMessagesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelChunk> {
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>()

  for await (const event of iterateSse(body)) {
    const data = event.data.trim()
    if (data.length === 0) continue
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      continue
    }

    const type = asString(get(frame, 'type')) ?? event.event
    if (type === 'content_block_start') {
      const index = asNumber(get(frame, 'index')) ?? toolCalls.size
      const block = get(frame, 'content_block')
      if (asString(get(block, 'type')) === 'tool_use') {
        const id = asString(get(block, 'id'))
        const name = asString(get(block, 'name'))
        toolCalls.set(index, {
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
          args: '',
        })
      }
      continue
    }

    if (type === 'content_block_delta') {
      const index = asNumber(get(frame, 'index')) ?? 0
      const delta = get(frame, 'delta')
      const deltaType = asString(get(delta, 'type'))
      if (deltaType === 'text_delta') {
        const text = asString(get(delta, 'text'))
        if (text !== undefined && text.length > 0) yield { type: 'text-delta', text }
      } else if (deltaType === 'thinking_delta') {
        const thinking = asString(get(delta, 'thinking'))
        if (thinking !== undefined && thinking.length > 0) yield { type: 'reasoning-delta', text: thinking }
      } else if (deltaType === 'input_json_delta') {
        const current = toolCalls.get(index) ?? { args: '' }
        toolCalls.set(index, { ...current, args: current.args + (asString(get(delta, 'partial_json')) ?? '') })
      }
      continue
    }

    if (type === 'content_block_stop') {
      const index = asNumber(get(frame, 'index')) ?? 0
      const call = toolCalls.get(index)
      if (call?.name !== undefined) {
        yield {
          type: 'tool-call',
          callId: call.id ?? `call_${index}`,
          name: call.name,
          args: parseToolArgs(call.args),
        }
        toolCalls.delete(index)
      }
      continue
    }

    const usage = get(frame, 'usage') ?? get(frame, 'message', 'usage')
    const usageRecord = asRecord(usage)
    if (usageRecord !== undefined && type === 'message_delta') {
      yield {
        type: 'usage',
        inputTokens: asNumber(usageRecord['input_tokens']) ?? 0,
        outputTokens: asNumber(usageRecord['output_tokens']) ?? 0,
      }
    }
  }
}

/** Anthropic Claude 原生 Messages API（非 OpenAI 兼容协议） */
export function createAnthropicAdapter(): ProviderKindAdapter {
  const listModels = async (
    provider: ModelProviderConfig,
    apiKey: string | null,
  ): Promise<Result<readonly string[]>> => {
    const result = await requestJson({
      provider,
      modelId: '',
      url: joinUrl(provider.baseUrl, 'models'),
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutOf(provider)),
      timeoutMs: timeoutOf(provider),
      secrets: [apiKey],
    })
    if (!result.ok) return result
    const ids = asArray(get(result.value, 'data'))
      .map((item) => asString(get(item, 'id')))
      .filter((id): id is string => id !== undefined)
    return ok(ids)
  }

  return {
    kind: 'anthropic',
    capabilities: { stream: true, tools: true, reasoning: true },

    async stream(resolved, request) {
      const result = await requestStream({
        provider: resolved.provider,
        modelId: resolved.modelId,
        url: joinUrl(resolved.provider.baseUrl, 'messages'),
        headers: authHeaders(resolved.apiKey),
        body: buildBody(resolved, request),
        signal: request.signal,
        timeoutMs: resolved.timeoutMs,
        secrets: [resolved.apiKey],
      })
      if (!result.ok) return result
      return ok(parseMessagesStream(result.value))
    },

    listModels,

    async test(provider, opts): Promise<Result<ProviderTestResult>> {
      const startedAt = Date.now()
      if (opts.mode === 'chat') {
        const entry = opts.entry
        if (entry === undefined) return err('ERR_VALIDATION', 'chat 模式测试需要指定模型条目')
        const resolved: ResolvedModel = {
          modelId: entry.id,
          provider,
          entry,
          kind: provider.kind,
          apiKey: opts.apiKey,
          timeoutMs: timeoutOf(provider),
        }
        const result = await requestJson({
          provider,
          modelId: entry.id,
          url: joinUrl(provider.baseUrl, 'messages'),
          headers: authHeaders(opts.apiKey),
          body: { ...buildBody(resolved, { model: entry.id, messages: [{ role: 'user', content: 'ping' }], signal: AbortSignal.timeout(timeoutOf(provider)) }), stream: false, max_tokens: 1 },
          signal: AbortSignal.timeout(timeoutOf(provider)),
          timeoutMs: timeoutOf(provider),
          secrets: [opts.apiKey],
        })
        return result.ok ? ok({ latencyMs: Date.now() - startedAt }) : result
      }
      const models = await listModels(provider, opts.apiKey)
      return models.ok ? ok({ latencyMs: Date.now() - startedAt, models: models.value }) : models
    },
  }
}
