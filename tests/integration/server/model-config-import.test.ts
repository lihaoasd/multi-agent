import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface ProviderBody {
  id: string
  baseUrl: string
  credential: { mode: string; envName?: string; hasValue: boolean; masked: string }
}

interface ModelBody {
  id: string
  providerId: string
  model: string
}

const LEGACY_KEY_VALUE = 'sk-legacy-value-123456'

describe('API · 模型配置：首次启动的遗留导入（model-config.md §11）', () => {
  let context: TestContext

  beforeAll(async () => {
    context = await createTestServer({
      envMap: {
        MODELS__PROVIDERS: JSON.stringify([
          {
            id: 'legacy-p',
            kind: 'openai-compatible',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'LEGACY_KEY',
            model: 'legacy-model',
          },
        ]),
        LEGACY_KEY: LEGACY_KEY_VALUE,
      },
    })
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('导入供应商与模型（S14：不再写平台默认模型）', async () => {
    const providers = (await inject({ method: 'GET', url: '/api/model-providers' })).json<ProviderBody[]>()
    const provider = providers.find((item) => item.id === 'legacy-p')
    expect(provider).toBeDefined()
    expect(provider?.baseUrl).toBe('https://api.example.com/v1')

    const models = (await inject({ method: 'GET', url: '/api/models' })).json<ModelBody[]>()
    expect(models.map((item) => item.id)).toContain('legacy-model')
  })

  it('env 模式凭证从合并环境映射解析（hasValue=true），但明文永不出现在响应里', async () => {
    const response = await inject({ method: 'GET', url: '/api/model-providers' })
    const provider = response.json<ProviderBody[]>().find((item) => item.id === 'legacy-p')
    expect(provider?.credential).toMatchObject({ mode: 'env', envName: 'LEGACY_KEY', hasValue: true })
    expect(response.body).not.toContain(LEGACY_KEY_VALUE)
  })

  it('导入后再次启动不重复导入（配置已存在）', async () => {
    const second = await context.deps.modelConfig.ensureInitialized()
    expect(second.ok && second.value.imported).toBe(0)
  })
})
