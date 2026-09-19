import type { ChatMessage, ModelChunk, ModelRequest } from '../../../ports/model'
import type { ModelProviderConfig, ProviderKindAdapter, ProviderTestResult, ResolvedModel } from '../../../ports/model-config'
import { err, ok, type Result } from '../../../shared/result'
import { requestJson, requestStream } from '../http'
import { asArray, asNumber, asRecord, asString, get, joinUrl, parseToolArgs } from '../json'
import { iterateSse } from '../stream'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './openai-compatible'

function timeoutOf(provider: ModelProviderConfig): number {
  return provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey === null ? {} : { 'x-goog-api-key': apiKey }
}

function buildContents(messages: readonly ChatMessage[]): {
  systemInstruction: Record<string, unknown> | undefined
  contents: readonly Record<string, unknown>[]
} {
  const systemParts: string[] = []
  const contents: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              ...(message.toolCallId === undefined ? {} : { name: message.toolCallId }),
              response: { content: message.content },
            },
          },
        ],
      })
      continue
    }
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })
  }
  return {
    systemInstruction:
      systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents,
  }
}

function buildBody(resolved: ResolvedModel, request: ModelRequest): Record<string, unknown> {
  const { systemInstruction, contents } = buildContents(request.messages)
  const temperature = request.temperature ?? resolved.entry.defaultParams?.temperature
  const maxOutputTokens =
    request.maxTokens ?? resolved.entry.defaultParams?.maxTokens ?? resolved.entry.maxOutputTokens
  // S40/D43：勾选「思考」的模型要求把思考摘要一并返回（`includeThoughts`），否则只有最终答案
  const reasoning = resolved.entry.capabilities.includes('reasoning')
  const thinkingBudget = resolved.entry.defaultParams?.thinkingBudget
  const generationConfig = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoning
      ? { thinkingConfig: { includeThoughts: true, ...(thinkingBudget === undefined ? {} : { thinkingBudget }) } }
      : {}),
  }
  return {
    contents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
        }),
  }
}

/** SSE：`candidates[].content.parts[]`（text / functionCall）+ `usageMetadata` */
async function* parseGenerateContentStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelChunk> {
  let toolIndex = 0
  for await (const event of iterateSse(body)) {
    const data = event.data.trim()
    if (data.length === 0) continue
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      continue
    }

    for (const part of asArray(get(frame, 'candidates', '0', 'content', 'parts'))) {
      const text = asString(get(part, 'text'))
      if (text !== undefined && text.length > 0) {
        yield { type: 'text-delta', text }
        continue
      }
      const functionCall = asRecord(get(part, 'functionCall'))
      if (functionCall !== undefined) {
        const name = asString(functionCall['name'])
        if (name !== undefined) {
          const args = functionCall['args']
          yield {
            type: 'tool-call',
            callId: asString(functionCall['id']) ?? `call_${toolIndex++}`,
            name,
            args: typeof args === 'string' ? parseToolArgs(args) : (args ?? {}),
          }
        }
      }
      const thought = part !== null && typeof part === 'object' ? (part as Record<string, unknown>)['thought'] : undefined
      if (thought === true && text !== undefined && text.length > 0) {
        yield { type: 'reasoning-delta', text }
      }
    }

    const usage = asRecord(get(frame, 'usageMetadata'))
    if (usage !== undefined) {
      yield {
        type: 'usage',
        inputTokens: asNumber(usage['promptTokenCount']) ?? 0,
        outputTokens: asNumber(usage['candidatesTokenCount']) ?? 0,
      }
    }
  }
}

/** Google Gemini 原生 generateContent API（非 OpenAI 兼容协议） */
export function createGeminiAdapter(): ProviderKindAdapter {
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
    const names = asArray(get(result.value, 'models'))
      .map((item) => asString(get(item, 'name')))
      .filter((name): name is string => name !== undefined)
      .map((name) => name.replace(/^models\//, ''))
    return ok(names)
  }

  return {
    kind: 'gemini',
    capabilities: { stream: true, tools: true, reasoning: true },

    async stream(resolved, request) {
      const result = await requestStream({
        provider: resolved.provider,
        modelId: resolved.modelId,
        url: `${joinUrl(resolved.provider.baseUrl, `models/${encodeURIComponent(resolved.entry.model)}:streamGenerateContent`)}?alt=sse`,
        headers: authHeaders(resolved.apiKey),
        body: buildBody(resolved, request),
        signal: request.signal,
        timeoutMs: resolved.timeoutMs,
        secrets: [resolved.apiKey],
      })
      if (!result.ok) return result
      return ok(parseGenerateContentStream(result.value))
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
          url: joinUrl(provider.baseUrl, `models/${encodeURIComponent(entry.model)}:generateContent`),
          headers: authHeaders(opts.apiKey),
          body: buildBody(resolved, {
            model: entry.id,
            messages: [{ role: 'user', content: 'ping' }],
            maxTokens: 1,
            signal: AbortSignal.timeout(timeoutOf(provider)),
          }),
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
