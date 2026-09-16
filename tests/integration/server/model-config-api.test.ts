import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface ProviderBody {
  id: string
  credential: { mode: string; masked: string; hasValue: boolean }
  modelCount: number
}

describe('API · 模型配置（FR-34 / 规则 27、28）', () => {
  let context: TestContext

  beforeAll(async () => {
    context = await createTestServer()
  })

  afterAll(async () => {
    await context.cleanup()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('出厂状态：不含任何供应商/模型（S10：Agent 默认不配置模型）', async () => {
    const providers = await inject({ method: 'GET', url: '/api/model-providers' })
    expect(providers.statusCode).toBe(200)
    expect(providers.json<ProviderBody[]>()).toEqual([])

    const models = await inject({ method: 'GET', url: '/api/models' })
    expect(models.json<Array<{ id: string }>>()).toEqual([])

    // S14：不再有「默认路由」；overview 也不再返回 routing 字段
    const overview = await inject({ method: 'GET', url: '/api/model-config/overview' })
    expect(overview.statusCode).toBe(200)
    expect(overview.json<Record<string, unknown>>()).not.toHaveProperty('routing')
  })

  it('预置目录包含 9 家供应商（不含任何假模型），且不含任何密钥', async () => {
    const response = await inject({ method: 'GET', url: '/api/model-presets' })
    expect(response.statusCode).toBe(200)
    const presets = response.json<Array<{ presetId: string; suggestedModels: unknown[] }>>()
    expect(presets).toHaveLength(9)
    expect(presets.map((item) => item.presetId)).toEqual(
      expect.arrayContaining([
        'deepseek',
        'openai',
        'anthropic',
        'gemini',
        'dashscope',
        'moonshot',
        'zhipu',
        'volcengine-ark',
        'ollama',
      ]),
    )
    expect(presets.map((item) => item.presetId)).not.toContain('mock')
    expect(response.body).not.toMatch(/sk-[A-Za-z0-9]/)
  })

  it('新增供应商：预置预填 + 连通性测试 + 模型发现', async () => {
    const created = await inject({ method: 'POST', url: '/api/model-providers', payload: { presetId: 'ollama' } })
    expect(created.statusCode).toBe(201)
    const provider = created.json<ProviderBody>()
    expect(provider.id).toBe('ollama')
    expect(provider.credential.hasValue).toBe(false)

    // Ollama 的测试/发现走 `/api/tags`：用替身 fetch 保证离线可跑（不依赖本机服务）
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    const tested = await inject({ method: 'POST', url: '/api/model-providers/ollama/test', payload: { mode: 'models' } })
    expect(tested.statusCode).toBe(200)
    expect(tested.json<{ models: string[] }>().models).toEqual(['qwen3:8b', 'llama3.2:3b'])

    const discovered = await inject({ method: 'GET', url: '/api/model-providers/ollama/discover' })
    expect(discovered.statusCode).toBe(200)
    expect(discovered.json<{ models: string[] }>().models).toEqual(['qwen3:8b', 'llama3.2:3b'])
  })

  it('凭证永不明文外发（规则 28）', async () => {
    const secret = 'sk-super-secret-123456'
    const created = await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: {
        id: 'openai-x',
        name: 'OpenAI 中转',
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        credential: { mode: 'file', value: secret },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain(secret)
    expect(created.json<ProviderBody>().credential.masked).toBe('sk-***3456')

    const list = await inject({ method: 'GET', url: '/api/model-providers' })
    expect(list.body).not.toContain(secret)

    const audit = await context.deps.fileStore.readText(`${context.dataDir}/config-audit.jsonl`)
    expect(audit.ok && audit.value).not.toContain(secret)
  })

  it('校验失败返回 ERR_VALIDATION（非法 id / 未注册 kind / env 变量缺失）', async () => {
    const badId = await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: { id: 'BAD ID', name: 'x', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    })
    expect(badId.statusCode).toBe(400)
    expect(badId.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    const badKind = await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: { id: 'p-nope', name: 'x', kind: 'not-a-kind', baseUrl: 'https://a.example.com' },
    })
    expect(badKind.statusCode).toBe(400)

    const badEnv = await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: {
        id: 'p-env',
        name: 'x',
        kind: 'openai-compatible',
        baseUrl: 'https://a.example.com',
        credential: { mode: 'env', envName: 'AGENT_HANESS_NOT_EXIST_VAR' },
      },
    })
    expect(badEnv.statusCode).toBe(400)
    expect(badEnv.json<{ message: string }>().message).toContain('AGENT_HANESS_NOT_EXIST_VAR')
  })

  it('模型条目：同供应商重名被拒，路由必须指向已启用模型', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/models',
      payload: { id: 'ollama-a', providerId: 'ollama', model: 'dup-model', displayName: '首个模型' },
    })
    expect(created.statusCode).toBe(201)

    const duplicated = await inject({
      method: 'POST',
      url: '/api/models',
      payload: { id: 'ollama-alt', providerId: 'ollama', model: 'dup-model', displayName: '重复模型名' },
    })
    expect(duplicated.statusCode).toBe(409)

    // S14：「默认路由」已删除，接口不再存在
    expect((await inject({ method: 'GET', url: '/api/model-routing' })).statusCode).toBe(404)
    expect(
      (
        await inject({
          method: 'PUT',
          url: '/api/model-routing',
          payload: { defaultModelId: 'ollama-a', stepOverrides: {} },
        })
      ).statusCode,
    ).toBe(404)
  })

  it('删除保护：有模型条目的供应商不可删（ERR_CONFLICT + referrers）', async () => {
    const blocked = await inject({ method: 'DELETE', url: '/api/model-providers/ollama' })
    expect(blocked.statusCode).toBe(409)
    const body = blocked.json<{ code: string; detail: { referrers: Array<{ id: string }> } }>()
    expect(body.code).toBe('ERR_CONFLICT')
    expect(body.detail.referrers.map((item) => item.id)).toEqual(expect.arrayContaining(['ollama-a']))
  })

  it('停用与删除模型：无 Agent 引用时直接允许，删除后供应商可删', async () => {
    // 未被任何模板/实例引用 → 停用无需 confirm（规则 10）
    const disabled = await inject({ method: 'PATCH', url: '/api/models/ollama-a', payload: { enabled: false } })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json<{ enabled: boolean }>().enabled).toBe(false)

    const enabled = await inject({ method: 'PATCH', url: '/api/models/ollama-a', payload: { enabled: true } })
    expect(enabled.json<{ enabled: boolean }>().enabled).toBe(true)

    // 未被引用 → 可直接删除（S14 起不再有"平台默认模型"需要一并清理）
    expect((await inject({ method: 'DELETE', url: '/api/models/ollama-a' })).statusCode).toBe(200)

    // 新建一个空供应商（无模型条目），验证可删除
    await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: {
        id: 'empty-prov',
        name: '空供应商',
        kind: 'openai-compatible',
        baseUrl: 'https://empty.example.com/v1',
        credential: { mode: 'file', value: 'sk-empty-prov-1234' },
      },
    })
    expect((await inject({ method: 'DELETE', url: '/api/model-providers/empty-prov' })).statusCode).toBe(200)
  })

  it('批量登记模型（发现清单导入）', async () => {
    const bulk = await inject({
      method: 'POST',
      url: '/api/models/bulk',
      payload: { providerId: 'ollama', models: [{ model: 'qwen3:8b' }, { model: 'llama3.2:3b' }] },
    })
    expect(bulk.statusCode).toBe(201)
    const body = bulk.json<{ created: string[]; skipped: string[] }>()
    expect(body.created).toHaveLength(2)
    expect(body.skipped).toEqual([])

    const again = await inject({
      method: 'POST',
      url: '/api/models/bulk',
      payload: { providerId: 'ollama', models: [{ model: 'qwen3:8b' }] },
    })
    expect(again.json<{ created: string[]; skipped: string[] }>().skipped).toEqual(['qwen3:8b'])
  })

  it('变更通过 WS 事件广播（S3 接 WS 网关前的端口断言）', async () => {
    const events = context.broadcaster.events()
    expect(events.some((event) => event.type === 'model-config.updated')).toBe(true)
    const payload = events.find((event) => event.type === 'model-config.updated')?.payload
    expect(payload).toHaveProperty('kind')
    expect(payload).toHaveProperty('id')
  })
})
