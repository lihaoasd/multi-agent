/**
 * 模型网关的 provider 路由与**孤儿回退**（M9D，2026-09-13）。
 *
 * 背景：角色实例的 `model` 是**创建时快照**的 provider id。provider 改名/删除后，
 * 存量实例的 model 就成了孤儿（用户实测：8 个实例都是 `deepseek-v4-flash`，
 * 而 .env 里 provider 已改名为 `DeepSeek-V4.1-Flash` → 原先直接抛
 * 「模型 provider 未配置: deepseek-v4-flash」，整个项目调不动模型）。
 *
 * 现在按文档口径逐级回退：实例 model → `models.default`；两者都不存在才报错。
 * 断言方式：**拦截 fetch**，看它实际打到了哪个 baseUrl（= 最终选中的 provider），
 * 全程不发真实网络请求。
 */
import { describe, expect, it, vi } from 'vitest'

import { ModelGateway } from '../../src/infra/model/gateway.js'
import type { ModelsConfig, ModelProviderConfig } from '../../src/shared/config.js'

const GOOD: ModelProviderConfig = {
  id: 'DeepSeek-V4.1-Flash',
  kind: 'openai-compatible',
  baseUrl: 'https://good.example/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  model: 'DeepSeek-V4.1-Flash',
}
const OTHER: ModelProviderConfig = {
  id: 'other-provider',
  kind: 'openai-compatible',
  baseUrl: 'https://other.example/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  model: 'other',
}

/** 跑一次调用，返回 { error, urls }：urls = 实际请求过的地址（据此判断选中了哪个 provider）。 */
async function probe(
  models: ModelsConfig,
  providerId?: string,
): Promise<{ error: string; urls: string[] }> {
  const urls: string[] = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    // 返回一个最小的 400：让 openai-compatible provider 正常收尾，避免重试/长等待
    return new Response(JSON.stringify({ error: { message: 'stub' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  })
  const gw = new ModelGateway({ models, apiKeyResolver: () => 'test-key' })
  let error = 'no-error'
  try {
    for await (const _ of gw.streamChat({ providerId, messages: [{ role: 'user', content: 'hi' }] })) {
      void _
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    spy.mockRestore()
  }
  return { error, urls }
}

describe('ModelGateway：provider 解析与孤儿回退', () => {
  it('实例 model 命中：打到实例指定的 provider', async () => {
    const { error, urls } = await probe({ default: OTHER.id, providers: [GOOD, OTHER] }, GOOD.id)
    expect(error).not.toContain('provider 未配置')
    expect(urls.some((u) => u.includes('good.example'))).toBe(true)
  })

  it('**孤儿实例 model → 回退 models.default**（本次回归的核心）', async () => {
    // 实例指向已不存在的 deepseek-v4-flash；default 指向 GOOD
    const { error, urls } = await probe({ default: GOOD.id, providers: [GOOD, OTHER] }, 'deepseek-v4-flash')
    expect(error).not.toContain('provider 未配置') // 不再因孤儿 id 直接失败
    expect(urls.some((u) => u.includes('good.example'))).toBe(true) // 实际路由到 default
  })

  it('实例未指定 model → 用 models.default', async () => {
    const { error, urls } = await probe({ default: GOOD.id, providers: [GOOD, OTHER] })
    expect(error).not.toContain('provider 未配置')
    expect(urls.some((u) => u.includes('good.example'))).toBe(true)
  })

  it('实例 model 与 default 都不存在 → 明确报错（带上真正找不到的 id）', async () => {
    const { error } = await probe({ default: 'ghost-provider', providers: [GOOD] }, 'also-ghost')
    expect(error).toContain('模型 provider 未配置')
    expect(error).toContain('also-ghost')
  })

  it('models.default=mock 时静默走 mock（离线演示不受 provider 改名影响）', async () => {
    const { error, urls } = await probe({ default: 'mock', providers: [GOOD] })
    expect(error).toBe('no-error')
    expect(urls).toEqual([]) // 完全没有网络请求
  })
})
