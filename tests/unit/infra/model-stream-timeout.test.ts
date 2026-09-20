import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestStream } from '../../../src/infra/model/http'
import type { ModelProviderConfig } from '../../../src/ports/model-config'

/**
 * S52/D55：`timeoutMs` 是**空闲超时**（多久没数据到达算失败），**不是总时长上限**。
 *
 * 真实事故：写 20~35KB 设计文档的回合总时长超过供应商配置的 60 秒 → 被
 * `AbortSignal.timeout(timeoutMs)`（从发起时刻算的固定截止）硬砍，报错
 * "模型流式响应中断：The operation was aborted due to timeout"，还白白重试 3 次。
 *
 * ⚠️ 替身必须**跟随传入的 `signal`**（真实 fetch 就是这样）：否则"中止"对替身毫无作用，
 * 用例会在新旧两种实现下都通过——那是假绿（本用例第一版就踩过这个坑）。
 */
const provider: ModelProviderConfig = {
  id: 'p1',
  name: 'P1',
  kind: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  credential: { mode: 'file', value: 'sk-test' },
  enabled: true,
  presetId: null,
  createdAt: '',
  updatedAt: '',
}

const encoder = new TextEncoder()

/** 按给定节奏吐数据；`signal` 中止时像真实 fetch 那样让流报错 */
function pacedResponse(gaps: readonly number[], init?: RequestInit): Response {
  // 用函数读取，避免 TS 把 `.aborted` 收窄成"永远是 false"（signal 是外部可变的）
  const isAborted = (): boolean => init?.signal?.aborted ?? false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = (): void => controller.error(new Error('The operation was aborted due to timeout'))
      if (isAborted()) {
        onAbort()
        return
      }
      init?.signal?.addEventListener('abort', onAbort, { once: true })
      for (const [index, gap] of gaps.entries()) {
        await new Promise((resolve) => setTimeout(resolve, gap))
        if (isAborted()) return
        controller.enqueue(encoder.encode(`data: ${index}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let chunks = 0
  for (;;) {
    const { done } = await reader.read()
    if (done) return chunks
    chunks += 1
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('S52 · 模型请求超时是"空闲超时"', () => {
  it('数据持续到达时，总时长可以远超 timeoutMs（长输出不再被砍）', async () => {
    // 每片间隔 60ms × 6 片 ≈ 360ms 总时长，空闲超时只有 100ms
    // 旧实现：fetch 挂 AbortSignal.timeout(100) → 100ms 处整体中止 → 本用例必红
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => Promise.resolve(pacedResponse([60, 60, 60, 60, 60, 60], init))),
    )
    const streamed = await requestStream({
      provider,
      modelId: 'm1',
      url: 'https://api.example.com/v1/chat/completions',
      signal: new AbortController().signal,
      timeoutMs: 100,
    })
    expect(streamed.ok).toBe(true)
    if (!streamed.ok) return
    await expect(drain(streamed.value)).resolves.toBe(6)
  })

  it('真的卡住（超过 timeoutMs 没有数据）→ 以可读的空闲超时原因失败', async () => {
    // 第一片立刻到，之后一直不再吐数据 → 100ms 空闲后中止
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: 第一片\n\n'))
                // 之后什么都不做：不 close、不 enqueue
                void init
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )
    const streamed = await requestStream({
      provider,
      modelId: 'm1',
      url: 'https://api.example.com/v1/chat/completions',
      signal: new AbortController().signal,
      timeoutMs: 100,
    })
    expect(streamed.ok).toBe(true)
    if (!streamed.ok) return
    const reader = streamed.value.getReader()
    await reader.read() // 第一片
    await expect(reader.read()).rejects.toThrow(/空闲超时/)
  })

  it('拿不到响应头时给出"请求超时"的中文提示（连接阶段仍有截止）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // 模拟"响应头一直不来"：只跟随传入 signal 的 abort
            init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')))
          }),
      ),
    )
    const result = await requestStream({
      provider,
      modelId: 'm1',
      url: 'https://api.example.com/v1/chat/completions',
      signal: new AbortController().signal,
      timeoutMs: 80,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('模型请求超时')
    expect(result.error.message).toContain('调大超时')
  })

  it('用户取消（signal）仍然照常中断', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    setTimeout(() => controller.abort(), 30)
    const result = await requestStream({
      provider,
      modelId: 'm1',
      url: 'https://api.example.com/v1/chat/completions',
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ERR_MODEL')
  })
})
