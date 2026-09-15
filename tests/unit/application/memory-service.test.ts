import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryService, MEMORY_LIMITS } from '../../../src/application/memory/memory-service'
import { createEnvConfigProvider } from '../../../src/infra/config/env-config'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createMemoryStore } from '../../../src/infra/file-store/memory-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import { DEFAULT_APP_CONFIG } from '../../../src/shared/config'

const PROJECT = 'p_1'

function createService(): ReturnType<typeof createMemoryService> {
  const fileStore = createFileStore({ root: mkdtempSync(join(tmpdir(), 'ah-memsvc-')) })
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  return createMemoryService({
    store: createMemoryStore({ fileStore, lock: createKeyedLockManager(), clock, dataDir: 'data' }),
    ids: createIdGenerator(),
    clock,
    config: createEnvConfigProvider(DEFAULT_APP_CONFIG),
  })
}

const base = { projectId: PROJECT, sessionId: 'u_dev_1', seq: 7 } as const

/** 规则 6：L3 条目写入权限与校验 */
describe('application/memory-service · 记忆写入（规则 6）', () => {
  it('Agent 写入自己的角色记忆：scope=agent 且带 instanceId', async () => {
    const memory = createService()
    const written = await memory.appendOwn({ ...base, instanceId: 'dev_1', type: 'preference', content: '用户偏好中文注释' })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.value).toMatchObject({ scope: 'agent', instanceId: 'dev_1', state: 'active' })
    expect(written.value.source).toEqual({ sessionId: 'u_dev_1', seq: 7 })

    const listed = await memory.list(PROJECT, { scope: 'agent', instanceId: 'dev_1' })
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual([written.value.id])
  })

  it('全局记忆写入白名单：fact 被拒（ERR_FORBIDDEN），decision 放行', async () => {
    const memory = createService()
    const rejected = await memory.recordGlobal({ ...base, type: 'fact', content: '随便一条事实' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('ERR_FORBIDDEN')

    const allowed = await memory.recordGlobal({ ...base, type: 'decision', content: '采用方案 A' })
    expect(allowed.ok && allowed.value.scope).toBe('global')
    expect(allowed.ok && allowed.value.instanceId).toBeNull()

    const globals = await memory.list(PROJECT, { scope: 'global' })
    expect(globals.ok && globals.value).toHaveLength(1)
  })

  it('校验：空内容 / 超长内容 / 标签过多 → ERR_VALIDATION', async () => {
    const memory = createService()
    const empty = await memory.appendOwn({ ...base, instanceId: 'dev_1', type: 'fact', content: '   ' })
    expect(!empty.ok && empty.error.code).toBe('ERR_VALIDATION')

    const long = await memory.appendOwn({
      ...base,
      instanceId: 'dev_1',
      type: 'fact',
      content: 'x'.repeat(MEMORY_LIMITS.contentMaxChars + 1),
    })
    expect(!long.ok && long.error.code).toBe('ERR_VALIDATION')

    const manyTags = await memory.appendOwn({
      ...base,
      instanceId: 'dev_1',
      type: 'fact',
      content: '带很多标签',
      tags: Array.from({ length: MEMORY_LIMITS.tagsMax + 1 }, (_, index) => `t${index}`),
    })
    expect(!manyTags.ok && manyTags.error.code).toBe('ERR_VALIDATION')
  })

  it('supersede：旧条目保留但置 superseded（active 列表不再包含）', async () => {
    const memory = createService()
    const first = await memory.appendOwn({ ...base, instanceId: 'dev_1', type: 'fact', content: '方案 A' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await memory.appendOwn({ ...base, instanceId: 'dev_1', type: 'fact', content: '方案 B（取代 A）' })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const replaced = await memory.supersede(PROJECT, first.value.id, second.value.id)
    expect(replaced.ok && replaced.value.state).toBe('superseded')

    const active = await memory.activeFor(PROJECT, 'dev_1')
    expect(active.ok && active.value.map((item) => item.content)).toEqual(['方案 B（取代 A）'])

    const all = await memory.list(PROJECT, { scope: 'agent', instanceId: 'dev_1' })
    expect(all.ok && all.value).toHaveLength(2)
  })

  it('activeFor 同时返回全局与本人角色条目（不含他人）', async () => {
    const memory = createService()
    await memory.recordGlobal({ ...base, type: 'decision', content: '全局决策' })
    await memory.appendOwn({ ...base, instanceId: 'dev_1', type: 'fact', content: '开发自己的记忆' })
    await memory.appendOwn({ ...base, instanceId: 'qa_1', type: 'fact', content: '测试自己的记忆' })

    const active = await memory.activeFor(PROJECT, 'dev_1')
    expect(active.ok && active.value.map((item) => item.content).sort()).toEqual(['全局决策', '开发自己的记忆'])
  })
})
