import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

/**
 * S10 新增行为（`docs/plan/2026-09-16-s10-remove-mock.md` §4 S10.2）：
 * ① 旧数据迁移：剔除**已不再注册的协议 kind**（历史上的 mock）及其模型，并清理路由；
 * ② `MODELS__DEFAULT` 真正生效：初始化阶段以它为准（覆盖导入时的"第一条即默认"）；
 * ③ 出厂不再自动创建任何供应商/模型。
 */

interface ProviderBody {
  id: string
  kind: string
}

interface ModelBody {
  id: string
  providerId: string
}

const stamp = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function injectOf(context: TestContext): (options: InjectOptions) => Promise<LightMyRequestResponse> {
  return (options) => context.app.inject(options)
}

describe('S10 · 启动初始化：旧 kind 迁移与 MODELS__DEFAULT 生效', () => {
  it('迁移：剔除已删除 kind（mock）的供应商/模型，清理默认路由与步骤覆盖，并写审计', async () => {
    const root = `.test-tmp/${stamp()}-migration`
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(
      join(root, 'data', 'model-config.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        providers: [
          {
            id: 'legacy-mock',
            name: 'Mock（历史）',
            kind: 'mock',
            baseUrl: '',
            credential: { mode: 'file', value: '' },
            enabled: true,
            presetId: 'mock',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
          {
            id: 'keep-ollama',
            name: 'Ollama',
            kind: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            credential: { mode: 'file', value: '' },
            enabled: true,
            presetId: 'ollama',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ],
        models: [
          {
            id: 'legacy-mock',
            providerId: 'legacy-mock',
            model: 'mock',
            displayName: 'Mock 模型',
            capabilities: ['chat', 'stream'],
            enabled: true,
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
          {
            id: 'keep-model',
            providerId: 'keep-ollama',
            model: 'qwen3:8b',
            displayName: 'Qwen3 8B',
            capabilities: ['chat', 'stream'],
            enabled: true,
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ],
        routing: { defaultModelId: 'legacy-mock', stepOverrides: { critique: 'legacy-mock' } },
      }),
      'utf8',
    )

    const context = await createTestServer({ root })
    try {
      const inject = injectOf(context)
      const providers = (await inject({ method: 'GET', url: '/api/model-providers' })).json<ProviderBody[]>()
      expect(providers.map((item) => item.id)).toEqual(['keep-ollama'])
      expect(providers.map((item) => item.kind)).not.toContain('mock')

      const models = (await inject({ method: 'GET', url: '/api/models' })).json<ModelBody[]>()
      expect(models.map((item) => item.id)).toEqual(['keep-model'])

      const routing = (await inject({ method: 'GET', url: '/api/model-routing' })).json<{
        defaultModelId: string | null
        stepOverrides: Record<string, string>
      }>()
      expect(routing.defaultModelId).toBeNull()
      expect(routing.stepOverrides).toEqual({})

      const audit = await context.deps.fileStore.readText(`${context.dataDir}/config-audit.jsonl`)
      expect(audit.ok).toBe(true)
      if (audit.ok) {
        expect(audit.value).toContain('legacy-mock')
        expect(audit.value).toContain('"migrate"')
        expect(audit.value).toContain('removedProviders')
      }
    } finally {
      await context.cleanup()
    }
  })

  it('MODELS__DEFAULT 生效：初始化以它为准，而不是"第一条导入即默认"', async () => {
    const context = await createTestServer({
      envMap: {
        MODELS__PROVIDERS: JSON.stringify([
          {
            id: 'p-a',
            kind: 'openai-compatible',
            baseUrl: 'https://a.example.com/v1',
            apiKeyEnv: 'KEY_A',
            model: 'model-a',
          },
          {
            id: 'p-b',
            kind: 'openai-compatible',
            baseUrl: 'https://b.example.com/v1',
            apiKeyEnv: 'KEY_B',
            model: 'model-b',
          },
        ]),
        MODELS__DEFAULT: 'model-b',
        KEY_A: 'sk-a-value-123456',
        KEY_B: 'sk-b-value-123456',
      },
    })
    try {
      const inject = injectOf(context)
      const models = (await inject({ method: 'GET', url: '/api/models' })).json<ModelBody[]>()
      expect(models.map((item) => item.id)).toEqual(expect.arrayContaining(['model-a', 'model-b']))

      const routing = (await inject({ method: 'GET', url: '/api/model-routing' })).json<{ defaultModelId: string }>()
      expect(routing.defaultModelId).toBe('model-b')
    } finally {
      await context.cleanup()
    }
  })

  it('MODELS__DEFAULT 指向不存在的条目：保持导入结果，不静默换模型（D20-⑥）', async () => {
    const context = await createTestServer({
      envMap: {
        MODELS__PROVIDERS: JSON.stringify([
          {
            id: 'only-p',
            kind: 'openai-compatible',
            baseUrl: 'https://only.example.com/v1',
            apiKeyEnv: 'ONLY_KEY',
            model: 'only-model',
          },
        ]),
        MODELS__DEFAULT: 'ghost-model',
        ONLY_KEY: 'sk-only-value-123456',
      },
    })
    try {
      const inject = injectOf(context)
      const routing = (await inject({ method: 'GET', url: '/api/model-routing' })).json<{ defaultModelId: string }>()
      expect(routing.defaultModelId).toBe('only-model')
    } finally {
      await context.cleanup()
    }
  })

  it('出厂空配置：不自动创建任何供应商/模型（Agent 默认未配置模型）', async () => {
    const context = await createTestServer()
    try {
      const inject = injectOf(context)
      expect((await inject({ method: 'GET', url: '/api/model-providers' })).json<unknown[]>()).toEqual([])
      expect((await inject({ method: 'GET', url: '/api/models' })).json<unknown[]>()).toEqual([])
      expect(
        (await inject({ method: 'GET', url: '/api/model-routing' })).json<{ defaultModelId: string | null }>()
          .defaultModelId,
      ).toBeNull()
    } finally {
      await context.cleanup()
    }
  })
})
