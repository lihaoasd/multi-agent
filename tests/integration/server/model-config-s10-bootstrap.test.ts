import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

/**
 * 启动初始化迁移（`docs/plan/2026-09-16-s10-remove-mock.md`、`docs/plan/2026-09-16-s14-remove-model-routing.md`）：
 * ① S10：剔除**已不再注册的协议 kind**（历史上的 mock）及其模型条目；
 * ② S14：剔除已删除的「默认路由」（`routing`）字段 —— 存储层丢弃 + 启动时回写抹掉 + 审计；
 * ③ 出厂不再自动创建任何供应商/模型，也没有任何"平台默认模型"。
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

function seedConfig(root: string, snapshot: Record<string, unknown>): void {
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'model-config.json'), JSON.stringify(snapshot), 'utf8')
}

const PROVIDER = (id: string, kind: string, baseUrl: string): Record<string, unknown> => ({
  id,
  name: id,
  kind,
  baseUrl,
  credential: { mode: 'file', value: '' },
  enabled: true,
  presetId: null,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
})

const MODEL = (id: string, providerId: string, model: string): Record<string, unknown> => ({
  id,
  providerId,
  model,
  displayName: model,
  capabilities: ['chat', 'stream'],
  enabled: true,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
})

describe('启动初始化迁移（S10 旧 kind + S14 routing）', () => {
  it('迁移：剔除已删除 kind（mock）的供应商/模型，并抹掉已废弃的 routing 字段（都写审计）', async () => {
    const root = `.test-tmp/${stamp()}-migration`
    seedConfig(root, {
      schemaVersion: 1,
      revision: 3,
      providers: [
        PROVIDER('legacy-mock', 'mock', ''),
        PROVIDER('keep-ollama', 'ollama', 'http://127.0.0.1:11434'),
      ],
      models: [MODEL('legacy-mock', 'legacy-mock', 'mock'), MODEL('keep-model', 'keep-ollama', 'qwen3:8b')],
      routing: { defaultModelId: 'legacy-mock', stepOverrides: { critique: 'legacy-mock' } },
    })

    const context = await createTestServer({ root })
    try {
      const inject = injectOf(context)
      const providers = (await inject({ method: 'GET', url: '/api/model-providers' })).json<ProviderBody[]>()
      expect(providers.map((item) => item.id)).toEqual(['keep-ollama'])
      expect(providers.map((item) => item.kind)).not.toContain('mock')

      const models = (await inject({ method: 'GET', url: '/api/models' })).json<ModelBody[]>()
      expect(models.map((item) => item.id)).toEqual(['keep-model'])

      // 原文件里的 routing 已被真正抹掉（不只是解析时忽略）
      const raw = await context.deps.fileStore.readJson<Record<string, unknown>>(
        `${context.dataDir}/model-config.json`,
      )
      expect(raw.ok).toBe(true)
      if (raw.ok) expect(raw.value['routing']).toBeUndefined()

      const audit = await context.deps.fileStore.readText(`${context.dataDir}/config-audit.jsonl`)
      expect(audit.ok).toBe(true)
      if (audit.ok) {
        expect(audit.value).toContain('"migrate"')
        expect(audit.value).toContain('removedProviders')
        expect(audit.value).toContain('legacy-mock')
        expect(audit.value).toContain('"removed":["routing"]')
      }
    } finally {
      await context.cleanup()
    }
  })

  it('迁移：仅有已废弃 routing 时也会被清理并审计', async () => {
    const root = `.test-tmp/${stamp()}-routing-only`
    seedConfig(root, {
      schemaVersion: 1,
      revision: 5,
      providers: [PROVIDER('keep-ollama', 'ollama', 'http://127.0.0.1:11434')],
      models: [MODEL('keep-model', 'keep-ollama', 'qwen3:8b')],
      routing: { defaultModelId: 'keep-model' },
    })

    const context = await createTestServer({ root })
    try {
      const raw = await context.deps.fileStore.readJson<Record<string, unknown>>(
        `${context.dataDir}/model-config.json`,
      )
      expect(raw.ok && raw.value['routing']).toBeUndefined()

      const audit = await context.deps.fileStore.readText(`${context.dataDir}/config-audit.jsonl`)
      expect(audit.ok && audit.value.includes('"removed":["routing"]')).toBe(true)
    } finally {
      await context.cleanup()
    }
  })

  it('出厂空配置：不自动创建任何供应商/模型，也没有平台默认模型', async () => {
    const context = await createTestServer()
    try {
      const inject = injectOf(context)
      expect((await inject({ method: 'GET', url: '/api/model-providers' })).json<unknown[]>()).toEqual([])
      expect((await inject({ method: 'GET', url: '/api/models' })).json<unknown[]>()).toEqual([])
      const overview = (await inject({ method: 'GET', url: '/api/model-config/overview' })).json<{
        unconfiguredAgents: { total: number }
        routing?: unknown
      }>()
      expect(overview.unconfiguredAgents.total).toBe(0)
      expect(overview).not.toHaveProperty('routing')
    } finally {
      await context.cleanup()
    }
  })
})
