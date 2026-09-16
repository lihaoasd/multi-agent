import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import {
  createModelConfigStore,
  hasLegacyRouting,
  isLegacyV0,
  parseModelConfigSnapshot,
} from '../../../src/infra/file-store/model-config-store'
import { EMPTY_MODEL_CONFIG, type ModelConfigSnapshot } from '../../../src/ports/model-config'

const PATH = 'data/model-config.json'

async function createStore(): Promise<{
  store: ReturnType<typeof createModelConfigStore>
  fileStore: ReturnType<typeof createFileStore>
}> {
  const root = mkdtempSync(join(tmpdir(), 'ah-model-config-'))
  const fileStore = createFileStore({ root })
  const store = createModelConfigStore({
    fileStore,
    path: PATH,
    auditPath: 'data/config-audit.jsonl',
    now: () => new Date('2026-09-15T00:00:00.000Z'),
  })
  return { store, fileStore }
}

function snapshotWithProviders(): ModelConfigSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    providers: [
      {
        id: 'prov-a',
        name: 'A',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        credential: { mode: 'file', value: '' },
        enabled: true,
        presetId: 'ollama',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
    models: [],
  }
}

describe('infra/model-config-store', () => {
  it('文件不存在时返回空配置（revision=0），不报错', async () => {
    const { store } = await createStore()
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.value.snapshot).toEqual(EMPTY_MODEL_CONFIG)
      expect(loaded.value.notices).toEqual([])
    }
  })

  it('保存成功 revision 递增，并能被重新读回', async () => {
    const { store } = await createStore()
    const saved = await store.save(snapshotWithProviders(), 0)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.revision).toBe(1)

    const reloaded = await store.load()
    expect(reloaded.ok && reloaded.value.snapshot.revision).toBe(1)
    expect(reloaded.ok && reloaded.value.snapshot.providers[0]?.id).toBe('prov-a')
  })

  it('revision 不匹配 → ERR_CONFLICT（乐观并发）', async () => {
    const { store } = await createStore()
    await store.save(snapshotWithProviders(), 0)
    const conflict = await store.save(snapshotWithProviders(), 0)
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('ERR_CONFLICT')
      expect(conflict.error.detail).toMatchObject({ expectedRevision: 0, actualRevision: 1 })
    }
  })

  it('遗留 v0 形状：备份为 .v0.bak.json 并按空配置启动（不自动导入）', async () => {
    const { store, fileStore } = await createStore()
    await fileStore.writeJsonAtomic(PATH, {
      entries: [{ id: 'deepseek', name: 'DS', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat' }],
      defaultModel: 'deepseek-flash',
    })

    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.value.snapshot.providers).toEqual([])
      expect(loaded.value.notices[0]?.kind).toBe('legacy-v0-backup')
    }
    expect(await fileStore.exists('data/model-config.v0.bak.json')).toBe(true)
    expect(await fileStore.exists(PATH)).toBe(false)
    // 备份保留原内容，供用户显式点击"导入"时使用
    const legacy = await store.loadLegacyV0()
    expect(legacy.ok).toBe(true)
    if (legacy.ok) {
      expect(legacy.value).toMatchObject({ defaultModel: 'deepseek-flash' })
    }
  })

  it('坏 JSON：备份为 .invalid.bak.json 并按空配置启动', async () => {
    const { store, fileStore } = await createStore()
    await fileStore.writeTextAtomic(PATH, '{ 这不是 JSON')
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.value.notices[0]?.kind).toBe('invalid-file-backup')
    expect(await fileStore.exists('data/model-config.invalid.bak.json')).toBe(true)
  })

  it('审计追加一行 JSONL，且不含密钥明文', async () => {
    const { store, fileStore } = await createStore()
    const appended = await store.appendAudit({
      id: 'cfg_1',
      ts: '',
      actor: 'user',
      scope: 'platform',
      target: { kind: 'provider', id: 'prov-a' },
      action: 'update',
      credentialTouched: true,
    })
    expect(appended.ok).toBe(true)
    const text = await fileStore.readText('data/config-audit.jsonl')
    expect(text.ok).toBe(true)
    if (text.ok) {
      const line = JSON.parse(text.value.trim()) as Record<string, unknown>
      expect(line).toMatchObject({ id: 'cfg_1', action: 'update', credentialTouched: true })
      expect(line['ts']).toBe('2026-09-15T00:00:00.000Z')
      expect(text.value).not.toMatch(/sk-/)
    }
  })
})

describe('infra/model-config-store · 解析', () => {
  it('拒绝不支持的 schemaVersion', () => {
    const parsed = parseModelConfigSnapshot({ schemaVersion: 2 })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('ERR_VALIDATION')
  })

  it('丢弃结构不完整的条目，保留合法条目', () => {
    const parsed = parseModelConfigSnapshot({
      schemaVersion: 1,
      revision: 3,
      providers: [
        { id: 'p1', name: 'P1', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', credential: { mode: 'file', value: '' } },
        { name: '缺 id' },
      ],
      models: [{ id: 'm1', providerId: 'p1', model: 'qwen3:8b' }, { id: 'm2' }],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.revision).toBe(3)
      expect(parsed.value.providers).toHaveLength(1)
      expect(parsed.value.models).toHaveLength(1)
    }
  })

  it('S14：已废弃的 routing 字段被丢弃，并给出 routing-removed notice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-model-config-legacy-'))
    const fileStore = createFileStore({ root })
    await fileStore.writeTextAtomic(
      PATH,
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        providers: [],
        models: [],
        routing: { defaultModelId: 'm1', stepOverrides: { act: 'm1' } },
      })}\n`,
    )
    const store = createModelConfigStore({ fileStore, path: PATH, auditPath: 'data/config-audit.jsonl' })

    expect(parseModelConfigSnapshot({ schemaVersion: 1, routing: {} }).ok).toBe(true)
    expect(hasLegacyRouting({ schemaVersion: 1, routing: {} })).toBe(true)
    expect(hasLegacyRouting({ schemaVersion: 1 })).toBe(false)

    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.value.notices).toEqual([{ kind: 'routing-removed' }])
      expect(loaded.value.snapshot).toEqual({ schemaVersion: 1, revision: 2, providers: [], models: [] })
    }
  })

  it('isLegacyV0 只认"无 schemaVersion + entries 数组"', () => {
    expect(isLegacyV0({ entries: [], defaultModel: 'x' })).toBe(true)
    expect(isLegacyV0({ schemaVersion: 1, providers: [] })).toBe(false)
    expect(isLegacyV0(null)).toBe(false)
  })
})
