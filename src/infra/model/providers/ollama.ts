import type { ModelChunk, ModelRequest } from '../../../ports/model'
import type { ModelProviderConfig, ProviderKindAdapter, ProviderTestResult, ResolvedModel } from '../../../ports/model-config'
import { err, ok, type Result } from '../../../shared/result'
import { requestJson, requestStream } from '../http'
import { asArray, asNumber, asRecord, asString, get, joinUrl, parseToolArgs } from '../json'
import { iterateNdjson } from '../stream'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './openai-compatible'

function timeoutOf(provider: ModelProviderConfig): number {
  return provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }
}

function buildBody(resolved: ResolvedModel, request: ModelRequest): Record<string, unknown> {
  const temperature = request.temperature ?? resolved.entry.defaultParams?.temperature
  const maxTokens = request.maxTokens ?? resolved.entry.defaultParams?.maxTokens
  return {
    model: resolved.entry.model,
    stream: true,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    })),
    options: {
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { num_predict: maxTokens }),
    },
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
  }
}

/** NDJSON：每行一个 JSON，`message.content` 增量，末行 `done:true` 带计数 */
async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelChunk> {
  let toolIndex = 0
  for await (const line of iterateNdjson(body)) {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }

    const message = asRecord(get(frame, 'message'))
    const content = asString(message?.['content'])
    if (content !== undefined && content.length > 0) {
      yield { type: 'text-delta', text: content }
    }
    const thinking = asString(message?.['thinking'])
    if (thinking !== undefined && thinking.length > 0) {
      yield { type: 'reasoning-delta', text: thinking }
    }

    for (const rawCall of asArray(message?.['tool_calls'])) {
      const name = asString(get(rawCall, 'function', 'name'))
      if (name === undefined) continue
      const rawArgs = get(rawCall, 'function', 'arguments')
      yield {
        type: 'tool-call',
        callId: asString(get(rawCall, 'id')) ?? `call_${toolIndex++}`,
        name,
        args: typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : (rawArgs ?? {}),
      }
    }

    if (frame !== null && typeof frame === 'object' && (frame as Record<string, unknown>)['done'] === true) {
      yield {
        type: 'usage',
        inputTokens: asNumber((frame as Record<string, unknown>)['prompt_eval_count']) ?? 0,
        outputTokens: asNumber((frame as Record<string, unknown>)['eval_count']) ?? 0,
      }
      return
    }
  }
}

/** Ollama 本地服务：`{baseUrl}/api/chat`（NDJSON）、`{baseUrl}/api/tags`（列模型） */
export function createOllamaAdapter(): ProviderKindAdapter {
  const listModels = async (
    provider: ModelProviderConfig,
    apiKey: string | null,
  ): Promise<Result<readonly string[]>> => {
    const result = await requestJson({
      provider,
      modelId: '',
      url: joinUrl(provider.baseUrl, 'api/tags'),
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutOf(provider)),
      timeoutMs: timeoutOf(provider),
      secrets: [apiKey],
    })
    if (!result.ok) return result
    const names = asArray(get(result.value, 'models'))
      .map((item) => asString(get(item, 'name')))
      .filter((name): name is string => name !== undefined)
    return ok(names)
  }

  return {
    kind: 'ollama',
    capabilities: { stream: true, tools: true, reasoning: false },

    async stream(resolved, request) {
      const result = await requestStream({
        provider: resolved.provider,
        modelId: resolved.modelId,
        url: joinUrl(resolved.provider.baseUrl, 'api/chat'),
        headers: authHeaders(resolved.apiKey),
        body: buildBody(resolved, request),
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
        const result = await requestJson({
          provider,
          modelId: entry.id,
          url: joinUrl(provider.baseUrl, 'api/chat'),
          headers: authHeaders(opts.apiKey),
          body: {
            model: entry.model,
            stream: false,
            messages: [{ role: 'user', content: 'ping' }],
            options: { num_predict: 1 },
          },
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
