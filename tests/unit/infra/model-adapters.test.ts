import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactSecrets } from '../../../src/infra/model/redact'
import { createOpenAiCompatibleAdapter } from '../../../src/infra/model/providers/openai-compatible'
import { createAnthropicAdapter } from '../../../src/infra/model/providers/anthropic'
import { createGeminiAdapter } from '../../../src/infra/model/providers/gemini'
import { createOllamaAdapter } from '../../../src/infra/model/providers/ollama'
import { createInMemoryAdapter } from '../../helpers-in-memory-adapter'
import type { ModelChunk, ModelRequest } from '../../../src/ports/model'
import type { ResolvedModel } from '../../../src/ports/model-config'

const encoder = new TextEncoder()

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function resolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    modelId: 'p1-m',
    kind: 'openai-compatible',
    apiKey: 'sk-test-secret-value',
    timeoutMs: 5000,
    provider: {
      id: 'p1',
      name: 'P1',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: { mode: 'file', value: 'sk-test-secret-value' },
      enabled: true,
      presetId: null,
      createdAt: '',
      updatedAt: '',
    },
    entry: {
      id: 'p1-m',
      providerId: 'p1',
      model: 'demo-model',
      displayName: 'Demo',
      capabilities: ['chat', 'stream'],
      enabled: true,
      createdAt: '',
      updatedAt: '',
    },
    ...overrides,
  }
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'p1-m',
    messages: [{ role: 'user', content: '你好' }],
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('in-memory 适配器替身（规则 31：归一化基准实现，位于 tests/）', () => {
  it('按片输出 text-delta，末尾给 usage，拼接结果等于回复全文', async () => {
    const adapter = createInMemoryAdapter({ chunkSize: 5, reply: () => '你好，这是替身回复。' })
    const streamed = await adapter.stream(resolved(), request())
    expect(streamed.ok).toBe(true)
    if (!streamed.ok) return

    const chunks = await collect(streamed.value)
    const text = chunks
      .filter((chunk): chunk is { type: 'text-delta'; text: string } => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('')
    expect(text).toBe('你好，这是替身回复。')
    expect(chunks.at(-1)?.type).toBe('usage')
  })

  it('默认剧本回声最后一条用户消息，并可由 listModels/test 提供能力', async () => {
    const adapter = createInMemoryAdapter()
    const streamed = await adapter.stream(resolved(), request())
    if (!streamed.ok) throw new Error('替身流启动失败')
    const text = (await collect(streamed.value))
      .filter((chunk): chunk is { type: 'text-delta'; text: string } => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('')
    expect(text).toContain('[in-memory:p1-m]')
    expect(text).toContain('你好')

    const models = await adapter.listModels?.(resolved().provider, null)
    expect(models?.ok && models.value).toEqual(['in-memory'])
    const tested = await adapter.test?.(resolved().provider, { mode: 'models', apiKey: null })
    expect(tested?.ok).toBe(true)
  })

  it('已取消的 signal：流中途抛错（供上层转 error 事件）', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = createInMemoryAdapter()
    const streamed = await adapter.stream(resolved(), request({ signal: controller.signal }))
    if (!streamed.ok) throw new Error('替身流启动失败')
    await expect(collect(streamed.value)).rejects.toThrow(/已取消/)
  })
})

describe('openai-compatible 适配器归一化', () => {
  it('SSE：content / reasoning_content / tool_calls(分片) / usage 全部归一', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read_file","arguments":"{\\"path\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      'data: [DONE]',
    ]
    const fetchMock = vi.fn(async () => sseResponse(frames))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createOpenAiCompatibleAdapter()
    const streamed = await adapter.stream(resolved(), request())
    if (!streamed.ok) throw new Error('流启动失败')
    const chunks = await collect(streamed.value)

    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(2)
    expect(chunks.find((chunk) => chunk.type === 'reasoning-delta')).toEqual({
      type: 'reasoning-delta',
      text: '想一想',
    })
    expect(chunks.find((chunk) => chunk.type === 'tool-call')).toEqual({
      type: 'tool-call',
      callId: 'call_1',
      name: 'fs_read_file',
      args: { path: 'a.txt' },
    })
    expect(chunks.find((chunk) => chunk.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 7,
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test-secret-value')
  })

  it('坏帧被跳过，不中断整条流', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {不是 JSON}', 'data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']),
      ),
    )
    const adapter = createOpenAiCompatibleAdapter()
    const streamed = await adapter.stream(resolved(), request())
    if (!streamed.ok) throw new Error('流启动失败')
    const chunks = await collect(streamed.value)
    expect(chunks).toEqual([{ type: 'text-delta', text: 'ok' }])
  })

  it('HTTP 错误 → ERR_MODEL，且错误信息中的密钥已脱敏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized: key=sk-test-secret-value', { status: 401 })),
    )
    const adapter = createOpenAiCompatibleAdapter()
    const result = await adapter.stream(resolved(), request())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_MODEL')
      const detail = JSON.stringify(result.error)
      expect(detail).not.toContain('sk-test-secret-value')
      expect(detail).toContain('***')
    }
  })

  it('listModels 读取 data[].id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })),
    )
    const adapter = createOpenAiCompatibleAdapter()
    const models = await adapter.listModels?.(resolved().provider, 'sk-test-secret-value')
    expect(models?.ok && models.value).toEqual(['a', 'b'])
  })

  it('S40：勾选「思考」才发思考参数，并回传 reasoning_content（DeepSeek 带 tools 时硬要求）', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"choices":[{"delta":{"content":"好"}}]}', 'data: [DONE]']))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createOpenAiCompatibleAdapter()
    const withReasoning = resolved({
      entry: { ...resolved().entry, capabilities: ['chat', 'stream', 'reasoning'] },
    })
    const streamed = await adapter.stream(
      withReasoning,
      request({
        tools: [{ name: 'fs_read_file', description: '读文件', parameters: {} }],
        messages: [
          { role: 'user', content: '读一下' },
          { role: 'assistant', content: '我来读', reasoning: '先看 a.txt' },
          { role: 'tool', content: '文件内容', toolCallId: 'call_1' },
        ],
      }),
    )
    if (!streamed.ok) throw new Error('流启动失败')
    await collect(streamed.value)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['reasoning_effort']).toBe('high')
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '我来读', reasoning_content: '先看 a.txt' })
  })

  it('S40：没勾选「思考」就不发思考参数，但已拿到的思考仍要回传（否则带 tools 的下一轮会被拒）', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"choices":[{"delta":{"content":"好"}}]}', 'data: [DONE]']))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createOpenAiCompatibleAdapter()
    const streamed = await adapter.stream(
      resolved(),
      request({ messages: [{ role: 'assistant', content: '我来读', reasoning: '先看 a.txt' }] }),
    )
    if (!streamed.ok) throw new Error('流启动失败')
    await collect(streamed.value)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['reasoning_effort']).toBeUndefined()
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]?.['reasoning_content']).toBe('先看 a.txt')
  })
})

describe('S40/D43 · 思考参数按能力标记下发（四种协议）', () => {
  const withReasoning = (kind: ResolvedModel['kind']): ResolvedModel =>
    resolved({
      kind,
      provider: { ...resolved().provider, kind, baseUrl: 'https://api.example.com/v1' },
      entry: { ...resolved().entry, capabilities: ['chat', 'stream', 'reasoning'] },
    })

  it('anthropic：不带 tools 时发 thinking（budget 夹在 max_tokens 之内）；带 tools 时不发（需 signature 回传，见遗留）', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"type":"message_stop"}']))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createAnthropicAdapter()
    const withoutTools = await adapter.stream(withReasoning('anthropic'), request())
    if (!withoutTools.ok) throw new Error('流启动失败')
    await collect(withoutTools.value).catch(() => undefined)
    let [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    let body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 3072 })
    expect(Number(body['max_tokens'])).toBeGreaterThan(3072)

    fetchMock.mockClear()
    const withTools = await adapter.stream(
      withReasoning('anthropic'),
      request({ tools: [{ name: 'fs_read_file', description: '读文件', parameters: {} }] }),
    )
    if (!withTools.ok) throw new Error('流启动失败')
    await collect(withTools.value).catch(() => undefined)
    ;[, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['thinking']).toBeUndefined()
  })

  it('gemini：发 thinkingConfig.includeThoughts', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}']))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createGeminiAdapter()
    const streamed = await adapter.stream(withReasoning('gemini'), request())
    if (!streamed.ok) throw new Error('流启动失败')
    await collect(streamed.value).catch(() => undefined)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['generationConfig']).toMatchObject({ thinkingConfig: { includeThoughts: true } })
    expect(String(url)).toContain('streamGenerateContent')
  })

  it('ollama：发顶层 think:true', async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":{"content":"好"},"done":true}\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createOllamaAdapter()
    const streamed = await adapter.stream(withReasoning('ollama'), request())
    if (!streamed.ok) throw new Error('流启动失败')
    await collect(streamed.value).catch(() => undefined)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body['think']).toBe(true)
  })
})

describe('infra/model/redact', () => {
  it('已知密钥值精确替换，常见键名前缀兜底', () => {
    expect(redactSecrets('token=sk-abcdef123456', ['sk-abcdef123456'])).toBe('token=***')
    expect(redactSecrets('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456')
    expect(redactSecrets('?key=abcdef123456')).not.toContain('abcdef123456')
  })

  it('短字符串不参与精确替换（避免把普通文本打成星号）', () => {
    expect(redactSecrets('abc', ['abc'])).toBe('abc')
  })
})
