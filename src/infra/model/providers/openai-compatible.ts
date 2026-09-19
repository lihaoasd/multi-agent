import type { ModelChunk, ModelRequest } from '../../../ports/model'
import type {
  ModelProviderConfig,
  ProviderKindAdapter,
  ProviderTestResult,
  ResolvedModel,
} from '../../../ports/model-config'
import { err, ok, type Result } from '../../../shared/result'
import { requestJson, requestStream } from '../http'
import { asArray, asNumber, asRecord, asString, get, joinUrl, parseToolArgs } from '../json'
import { iterateSse } from '../stream'

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function bearerHeaders(apiKey: string | null): Record<string, string> {
  return apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }
}

function effectiveParams(
  resolved: ResolvedModel,
  request: ModelRequest,
): { temperature?: number; maxTokens?: number } {
  const temperature = request.temperature ?? resolved.entry.defaultParams?.temperature
  const maxTokens = request.maxTokens ?? resolved.entry.defaultParams?.maxTokens
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/**
 * 是否要按"思考模式"发请求（S40/D43）：由**模型条目的能力标记**决定（`capabilities` 含 `reasoning`）。
 * 只在条目显式声明时发送思考参数——不同厂商的参数名不一致，乱发会被 400；勾选即表示"我知道这个模型支持"。
 */
function reasoningEnabled(resolved: ResolvedModel): boolean {
  return resolved.entry.capabilities.includes('reasoning')
}

function buildBody(resolved: ResolvedModel, request: ModelRequest, stream: boolean): Record<string, unknown> {
  const params = effectiveParams(resolved, request)
  const reasoning = reasoningEnabled(resolved)
  return {
    model: resolved.entry.model,
    stream,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      // S40/D43：思考模式 + 带 tools 时**必须回传** `reasoning_content`（DeepSeek 明确要求，否则 400）。
      // 这里**不看能力开关**：能力只管"要不要主动要求思考"，而模型可能本来就在思考（DeepSeek 默认开），
      // 拿到的思考一律带回去，才不会因为少回传而被拒。
      ...(message.reasoning === undefined || message.reasoning.length === 0
        ? {}
        : { reasoning_content: message.reasoning }),
    })),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxTokens === undefined ? {} : { max_tokens: params.maxTokens }),
    // 思考强度：DeepSeek 与 OpenAI 系都接受 `reasoning_effort`（DeepSeek 思考模式默认开、默认 high）
    ...(reasoning ? { reasoning_effort: resolved.entry.defaultParams?.reasoningEffort ?? 'high' } : {}),
  }
}

/** SSE 增量：`choices[].delta` 的 content / reasoning_content / tool_calls（参数分片需拼接） */
async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelChunk> {
  const partials = new Map<number, { id?: string; name?: string; args: string }>()

  for await (const event of iterateSse(body)) {
    const data = event.data.trim()
    if (data.length === 0) continue
    if (data === '[DONE]') break

    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      continue // 坏帧跳过：流式容错优先于严格失败
    }

    const delta = get(frame, 'choices', '0', 'delta')
    const content = asString(get(delta, 'content'))
    if (content !== undefined && content.length > 0) {
      yield { type: 'text-delta', text: content }
    }
    const reasoning = asString(get(delta, 'reasoning_content')) ?? asString(get(delta, 'reasoning'))
    if (reasoning !== undefined && reasoning.length > 0) {
      yield { type: 'reasoning-delta', text: reasoning }
    }

    for (const rawCall of asArray(get(delta, 'tool_calls'))) {
      const record = asRecord(rawCall)
      if (record === undefined) continue
      const index = asNumber(record['index']) ?? partials.size
      const current = partials.get(index) ?? { args: '' }
      const id = asString(record['id'])
      const name = asString(get(record, 'function', 'name'))
      const argsFragment = asString(get(record, 'function', 'arguments'))
      partials.set(index, {
        ...(id === undefined ? (current.id === undefined ? {} : { id: current.id }) : { id }),
        ...(name === undefined ? (current.name === undefined ? {} : { name: current.name }) : { name }),
        args: current.args + (argsFragment ?? ''),
      })
    }

    const usage = asRecord(get(frame, 'usage'))
    if (usage !== undefined) {
      yield {
        type: 'usage',
        inputTokens: asNumber(usage['prompt_tokens']) ?? 0,
        outputTokens: asNumber(usage['completion_tokens']) ?? 0,
      }
    }
  }

  for (const [index, call] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
    if (call.name === undefined) continue
    yield { type: 'tool-call', callId: call.id ?? `call_${index}`, name: call.name, args: parseToolArgs(call.args) }
  }
}

function pickModels(payload: unknown): readonly string[] {
  return asArray(get(payload, 'data'))
    .map((item) => asString(get(item, 'id')))
    .filter((id): id is string => id !== undefined)
}

function timeoutOf(provider: ModelProviderConfig): number {
  return provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
}

/**
 * OpenAI 兼容协议适配器：DeepSeek / OpenAI / 百炼兼容模式 / Kimi / GLM / 火山方舟 / 自定义。
 * 端点 `{baseUrl}/chat/completions`、`{baseUrl}/models`；认证 `Authorization: Bearer`。
 */
export function createOpenAiCompatibleAdapter(): ProviderKindAdapter {
  const listModels = async (
    provider: ModelProviderConfig,
    apiKey: string | null,
  ): Promise<Result<readonly string[]>> => {
    const result = await requestJson({
      provider,
      modelId: '',
      url: joinUrl(provider.baseUrl, 'models'),
      method: 'GET',
      headers: bearerHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutOf(provider)),
      timeoutMs: timeoutOf(provider),
      secrets: [apiKey],
    })
    return result.ok ? ok(pickModels(result.value)) : result
  }

  return {
    kind: 'openai-compatible',
    capabilities: { stream: true, tools: true, reasoning: true },

    async stream(resolved, request) {
      const result = await requestStream({
        provider: resolved.provider,
        modelId: resolved.modelId,
        url: joinUrl(resolved.provider.baseUrl, 'chat/completions'),
        headers: bearerHeaders(resolved.apiKey),
        body: buildBody(resolved, request, true),
        signal: request.signal,
        timeoutMs: resolved.timeoutMs,
        secrets: [resolved.apiKey],
      })
      if (!result.ok) return result
      return ok(parseChatStream(result.value))
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
          url: joinUrl(provider.baseUrl, 'chat/completions'),
          headers: bearerHeaders(opts.apiKey),
          body: buildBody(resolved, { model: entry.id, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, signal: AbortSignal.timeout(timeoutOf(provider)) }, false),
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
