import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createProjectStore, parseProjectMeta } from '../../../src/infra/file-store/project-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import type { ProjectMeta } from '../../../src/ports/project'

function createStore(): {
  store: ReturnType<typeof createProjectStore>
  fileStore: ReturnType<typeof createFileStore>
} {
  const root = mkdtempSync(join(tmpdir(), 'ah-project-'))
  const fileStore = createFileStore({ root })
  const store = createProjectStore({
    fileStore,
    lock: createKeyedLockManager(),
    clock: createFixedClock(new Date('2026-09-15T00:00:00.000Z')),
    dataDir: 'data',
  })
  return { store, fileStore }
}

function metaOf(id: string, name = '示例项目'): ProjectMeta {
  return {
    schemaVersion: 1,
    id,
    name,
    description: '描述',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    workdir: 'D:/dev/demo',
    workdirKind: 'empty',
    team: [],
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: true },
    approvalPolicy: { highRiskCommands: true },
  }
}

describe('infra/project-store', () => {
  it('创建项目：写出 project.json 与全部运行时记录文件/目录（data-storage §2）', async () => {
    const { store, fileStore } = createStore()
    const created = await store.create(metaOf('p_1'))
    expect(created.ok).toBe(true)

    expect(await fileStore.exists('data/projects/p_1/project.json')).toBe(true)
    for (const file of ['tasks.jsonl', 'questions.jsonl', 'approvals.jsonl', 'artifacts.jsonl', 'file-owners.jsonl']) {
      expect(await fileStore.exists(`data/projects/p_1/${file}`)).toBe(true)
    }
    for (const dir of ['sessions', 'memories', 'artifact-versions']) {
      expect((await fileStore.stat(`data/projects/p_1/${dir}`))?.isDirectory).toBe(true)
    }
  })

  it('重复创建同 id → ERR_CONFLICT', async () => {
    const { store } = createStore()
    await store.create(metaOf('p_1'))
    const again = await store.create(metaOf('p_1'))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('ERR_CONFLICT')
  })

  it('读取不存在 → ERR_NOT_FOUND', async () => {
    const { store } = createStore()
    const missing = await store.get('p_ghost')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ERR_NOT_FOUND')
  })

  it('update 走读改写并刷新 updatedAt；mutate 返回错误时不落盘', async () => {
    const { store } = createStore()
    await store.create(metaOf('p_1'))
    const renamed = await store.update('p_1', (meta) => ({ ok: true, value: { ...meta, name: '改名后' } }))
    expect(renamed.ok && renamed.value.name).toBe('改名后')
    expect(renamed.ok && renamed.value.updatedAt).toBe('2026-09-15T00:00:00.000Z')

    const rejected = await store.update('p_1', () => ({
      ok: false,
      error: { code: 'ERR_VALIDATION', message: '不允许' },
    }))
    expect(rejected.ok).toBe(false)
    const reloaded = await store.get('p_1')
    expect(reloaded.ok && reloaded.value.name).toBe('改名后')
  })

  it('list 扫描 project.json 并重建 index.json 投影', async () => {
    const { store, fileStore } = createStore()
    await store.create(metaOf('p_1', '甲'))
    await store.create(metaOf('p_2', '乙'))
    const listed = await store.list()
    expect(listed.ok && listed.value.map((item) => item.id).sort()).toEqual(['p_1', 'p_2'])

    const index = await fileStore.readJson<{ projects: Array<{ id: string }> }>('data/projects/index.json')
    expect(index.ok && index.value.projects.map((item) => item.id).sort()).toEqual(['p_1', 'p_2'])
  })

  it('remove 只删运行时项目文件夹；不存在 → ERR_NOT_FOUND', async () => {
    const { store, fileStore } = createStore()
    await store.create(metaOf('p_1'))
    expect((await store.remove('p_1')).ok).toBe(true)
    expect(await fileStore.exists('data/projects/p_1')).toBe(false)
    const again = await store.remove('p_1')
    expect(again.ok).toBe(false)
  })

  it('并发 update 不丢更新（KeyedLock 串行）', async () => {
    const { store } = createStore()
    await store.create(metaOf('p_1'))
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update('p_1', (meta) => ({
          ok: true,
          value: { ...meta, description: `${meta.description}${index}` },
        })),
      ),
    )
    const final = await store.get('p_1')
    expect(final.ok).toBe(true)
    if (final.ok) {
      expect(final.value.description.startsWith('描述')).toBe(true)
      // 10 次追加各 1 个数字字符，串行执行后不丢更新
      expect(final.value.description).toHaveLength('描述'.length + 10)
      expect(new Set(final.value.description.slice(2)).size).toBe(10)
    }
  })
})

describe('infra/project-store · 解析', () => {
  it('拒绝不支持的 schemaVersion / 缺 id', () => {
    expect(parseProjectMeta({ schemaVersion: 2 }).ok).toBe(false)
    expect(parseProjectMeta({ schemaVersion: 1 }).ok).toBe(false)
  })

  it('丢弃结构不完整的实例，保留合法实例', () => {
    const parsed = parseProjectMeta({
      schemaVersion: 1,
      id: 'p_1',
      name: 'x',
      team: [
        {
          instanceId: 'dev_1',
          roleTemplateId: 'dev',
          snapshot: { roleTemplateId: 'dev', systemPrompt: 'p' },
        },
        { instanceId: 'broken_1' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.team).toHaveLength(1)
      expect(parsed.value.team[0]?.instanceId).toBe('dev_1')
      expect(parsed.value.team[0]?.enabled).toBe(true)
    }
  })
})
