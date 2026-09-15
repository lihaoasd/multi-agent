import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createMemoryStore } from '../../../src/infra/file-store/memory-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import type { MemoryEntry, MemoryType } from '../../../src/ports/memory'
import type { ProjectId } from '../../../src/ports/project'

const PROJECT: ProjectId = 'p_1'

function createStore(): {
  store: ReturnType<typeof createMemoryStore>
  fileStore: ReturnType<typeof createFileStore>
} {
  const root = mkdtempSync(join(tmpdir(), 'ah-memory-'))
  const fileStore = createFileStore({ root })
  return {
    store: createMemoryStore({
      fileStore,
      lock: createKeyedLockManager(),
      clock: createFixedClock(new Date('2026-09-15T00:00:00.000Z')),
      dataDir: 'data',
    }),
    fileStore,
  }
}

function entry(input: {
  id: string
  scope: 'global' | 'agent'
  instanceId?: string | null
  type?: MemoryType
  content?: string
  ts?: string
}): MemoryEntry {
  return {
    id: input.id,
    ts: input.ts ?? '2026-09-15T00:00:00.000Z',
    scope: input.scope,
    instanceId: input.scope === 'global' ? null : (input.instanceId ?? 'dev_1'),
    type: input.type ?? 'fact',
    content: input.content ?? '内容',
    source: { sessionId: 'u_dev_1', seq: 3 },
    tags: ['t'],
    refs: [],
    state: 'active',
    supersededBy: null,
  }
}

describe('infra/memory-store · L3 条目（规则 6）', () => {
  it('按 scope 分别落盘：global.jsonl 与 <instanceId>.jsonl', async () => {
    const { store, fileStore } = createStore()
    await store.append(PROJECT, entry({ id: 'mem_1', scope: 'global', type: 'decision' }))
    await store.append(PROJECT, entry({ id: 'mem_2', scope: 'agent', instanceId: 'dev_1' }))

    expect(await fileStore.exists('data/projects/p_1/memories/global.jsonl')).toBe(true)
    expect(await fileStore.exists('data/projects/p_1/memories/dev_1.jsonl')).toBe(true)

    const global = await store.list(PROJECT, { scope: 'global' })
    expect(global.ok && global.value.map((item) => item.id)).toEqual(['mem_1'])
    const mine = await store.list(PROJECT, { scope: 'agent', instanceId: 'dev_1' })
    expect(mine.ok && mine.value.map((item) => item.id)).toEqual(['mem_2'])
    const all = await store.list(PROJECT)
    expect(all.ok && all.value).toHaveLength(2)
  })

  it('append-only：supersede 追加同 id 状态行，读取取最后一条且原行保留', async () => {
    const { store, fileStore } = createStore()
    await store.append(PROJECT, entry({ id: 'mem_1', scope: 'agent' }))
    const superseded = await store.supersede(PROJECT, 'mem_1', 'mem_2')
    expect(superseded.ok && superseded.value.state).toBe('superseded')
    expect(superseded.ok && superseded.value.supersededBy).toBe('mem_2')

    const text = await fileStore.readText('data/projects/p_1/memories/dev_1.jsonl')
    expect(text.ok && text.value.trim().split('\n')).toHaveLength(2)

    const listed = await store.list(PROJECT, { scope: 'agent', instanceId: 'dev_1' })
    expect(listed.ok && listed.value).toHaveLength(1)
    expect(listed.ok && listed.value[0]?.state).toBe('superseded')

    // 重复 supersede → ERR_CONFLICT（状态只能变一次）
    const again = await store.supersede(PROJECT, 'mem_1', 'mem_3')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('ERR_CONFLICT')
  })

  it('activeFor：只取 active，global 与本人角色分别限量、按时间倒序', async () => {
    const { store } = createStore()
    await store.append(PROJECT, entry({ id: 'g1', scope: 'global', ts: '2026-09-15T01:00:00.000Z' }))
    await store.append(PROJECT, entry({ id: 'g2', scope: 'global', ts: '2026-09-15T02:00:00.000Z' }))
    await store.append(PROJECT, entry({ id: 'r1', scope: 'agent', instanceId: 'dev_1', ts: '2026-09-15T03:00:00.000Z' }))
    await store.append(PROJECT, entry({ id: 'other', scope: 'agent', instanceId: 'qa_1' }))
    await store.append(PROJECT, entry({ id: 'dead', scope: 'agent', instanceId: 'dev_1' }))
    await store.supersede(PROJECT, 'dead', 'r1')

    const active = await store.activeFor(PROJECT, { instanceId: 'dev_1', globalLimit: 1, roleLimit: 5 })
    expect(active.ok && active.value.map((item) => item.id)).toEqual(['g2', 'r1'])
  })

  it('坏行容错：非法 JSON 行被跳过，其余条目仍可读', async () => {
    const { store, fileStore } = createStore()
    await store.append(PROJECT, entry({ id: 'mem_1', scope: 'global', type: 'decision' }))
    await fileStore.appendLine('data/projects/p_1/memories/global.jsonl', '{ 不是 JSON')
    await store.append(PROJECT, entry({ id: 'mem_2', scope: 'global', type: 'requirement' }))

    const listed = await store.list(PROJECT, { scope: 'global' })
    expect(listed.ok && listed.value.map((item) => item.id).sort()).toEqual(['mem_1', 'mem_2'])
  })

  it('校验：内容为空 / 角色条目缺 instanceId 都被拒绝', async () => {
    const { store } = createStore()
    const empty = await store.append(PROJECT, entry({ id: 'mem_x', scope: 'global', content: '   ' }))
    expect(empty.ok).toBe(false)
    const noInstance = await store.append(PROJECT, { ...entry({ id: 'mem_y', scope: 'agent' }), instanceId: null })
    expect(noInstance.ok).toBe(false)
  })

  it('get：不存在 → ERR_NOT_FOUND', async () => {
    const { store } = createStore()
    const found = await store.get(PROJECT, 'mem_missing')
    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.error.code).toBe('ERR_NOT_FOUND')
  })
})
