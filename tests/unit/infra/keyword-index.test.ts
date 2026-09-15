import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createMemoryStore } from '../../../src/infra/file-store/memory-store'
import { createSessionLogStore } from '../../../src/infra/file-store/session-log-store'
import { createSessionMetaStore } from '../../../src/infra/file-store/session-meta-store'
import { createKeywordIndex } from '../../../src/infra/indexer/keyword-index'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import { createSessionMeta } from '../../../src/application/session/session-meta-factory'
import type { MemoryEntry } from '../../../src/ports/memory'
import type { ProjectId, InstanceId } from '../../../src/ports/project'
import type { SessionId } from '../../../src/ports/session'

const PROJECT: ProjectId = 'p_1'
const DEV_SESSION: SessionId = 'u_dev_1'
const QA_SESSION: SessionId = 'u_qa_1'

interface Harness {
  readonly index: ReturnType<typeof createKeywordIndex>
  readonly logStore: ReturnType<typeof createSessionLogStore>
  readonly memoryStore: ReturnType<typeof createMemoryStore>
  readonly fileStore: ReturnType<typeof createFileStore>
  readonly clock: ReturnType<typeof createFixedClock>
}

async function createHarness(): Promise<Harness> {
  const fileStore = createFileStore({ root: mkdtempSync(join(tmpdir(), 'ah-index-')) })
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const lock = createKeyedLockManager()
  const metaStore = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
  const logStore = createSessionLogStore({ fileStore, metaStore, lock, clock, dataDir: 'data' })
  const memoryStore = createMemoryStore({ fileStore, lock, clock, dataDir: 'data' })
  for (const [sessionId, instanceId] of [
    [DEV_SESSION, 'dev_1'],
    [QA_SESSION, 'qa_1'],
  ] as const) {
    await metaStore.create(
      createSessionMeta({
        sessionId,
        projectId: PROJECT,
        instanceId,
        nowIso: '2026-09-15T00:00:00.000Z',
      }),
    )
  }
  return {
    index: createKeywordIndex({ fileStore, clock, dataDir: 'data', sessionMetaStore: metaStore, sessionLogStore: logStore, memoryStore }),
    logStore,
    memoryStore,
    fileStore,
    clock,
  }
}

function memoryEntry(id: string, content: string, instanceId: InstanceId | null): MemoryEntry {
  return {
    id,
    ts: '2026-09-15T00:00:00.000Z',
    scope: instanceId === null ? 'global' : 'agent',
    instanceId,
    type: 'fact',
    content,
    source: { sessionId: DEV_SESSION, seq: 1 },
    tags: [],
    refs: [],
    state: 'active',
    supersededBy: null,
  }
}

async function seed(harness: Harness): Promise<void> {
  await harness.logStore.append(PROJECT, DEV_SESSION, [
    { kind: 'message', turn: 1, payload: { role: 'user', text: '实现登录模块', content: { text: '实现登录模块' } } },
    { kind: 'turn_start', turn: 1, payload: {} },
    { kind: 'message', turn: 1, payload: { role: 'agent', text: '好的，先看现有代码', content: { text: '好的，先看现有代码' } } },
    { kind: 'tool_call', turn: 1, payload: { tool: 'fs_read_file', args: { path: 'workdir://src/login.ts' } } },
  ])
  await harness.logStore.append(PROJECT, QA_SESSION, [
    { kind: 'message', turn: 1, payload: { role: 'user', text: '回归测试支付流程', content: { text: '回归测试支付流程' } } },
  ])
  await harness.memoryStore.append(PROJECT, memoryEntry('mem_1', '用户偏好中文注释', 'dev_1'))
  await harness.memoryStore.append(PROJECT, memoryEntry('mem_2', '项目约定：提交前跑全量测试', null))
}

/** 规则 7：中文 2-gram 检索与跳转定位 */
describe('infra/keyword-index · 关键词倒排（规则 7 / 13）', () => {
  it('中文命中会话事件，返回可跳转的 (sessionId, seq)', async () => {
    const harness = await createHarness()
    await seed(harness)

    const hits = await harness.index.query(PROJECT, '登录模块')
    expect(hits.ok).toBe(true)
    if (!hits.ok) return
    const top = hits.value[0]
    expect(top).toMatchObject({ scope: 'session', sessionId: DEV_SESSION, seq: 1, kind: 'message' })
    expect(top?.tokens).toEqual(expect.arrayContaining(['登录', '录模', '模块']))
  })

  it('标点/换行边界不跨词元；未命中返回空数组', async () => {
    const harness = await createHarness()
    await seed(harness)
    const hits = await harness.index.query(PROJECT, '登录，录模')
    expect(hits.ok && hits.value.length).toBeGreaterThan(0)
    const none = await harness.index.query(PROJECT, '不存在的词汇组合')
    expect(none.ok && none.value).toEqual([])
  })

  it('scope 过滤：会话 / 记忆分别可查，记忆命中带 entryId', async () => {
    const harness = await createHarness()
    await seed(harness)

    const memories = await harness.index.query(PROJECT, '中文注释', { scope: 'memory' })
    expect(memories.ok && memories.value.map((hit) => hit.entryId)).toEqual(['mem_1'])

    const sessions = await harness.index.query(PROJECT, '中文注释', { scope: 'session' })
    expect(sessions.ok && sessions.value).toEqual([])
  })

  it('sessionId 过滤实现"会话内检索"', async () => {
    const harness = await createHarness()
    await seed(harness)
    const inDev = await harness.index.query(PROJECT, '测试', { sessionId: DEV_SESSION })
    const inQa = await harness.index.query(PROJECT, '测试', { sessionId: QA_SESSION })
    expect(inQa.ok && inQa.value.every((hit) => hit.sessionId === QA_SESSION)).toBe(true)
    expect(inQa.ok && inQa.value.length).toBeGreaterThan(0)
    expect(inDev.ok && inDev.value.every((hit) => hit.sessionId === DEV_SESSION)).toBe(true)
  })

  it('tool_call 事件按"工具名 + 参数"入索引（可检索工作目录路径）', async () => {
    const harness = await createHarness()
    await seed(harness)
    const hits = await harness.index.query(PROJECT, 'fs_read_file')
    expect(hits.ok && hits.value[0]?.kind).toBe('tool_call')
  })

  it('单字查询走汉字字符回退（弱命中）', async () => {
    const harness = await createHarness()
    await seed(harness)
    const hits = await harness.index.query(PROJECT, '登')
    expect(hits.ok && hits.value.length).toBeGreaterThan(0)
    expect(hits.ok && hits.value[0]?.score).toBeLessThanOrEqual(0.5)
  })

  it('增量：写入新事件后无需重建即可检索到（查询前 sync）', async () => {
    const harness = await createHarness()
    await seed(harness)
    await harness.logStore.append(PROJECT, DEV_SESSION, [
      { kind: 'message', turn: 2, payload: { role: 'agent', text: '已补充支付回调校验', content: { text: '已补充支付回调校验' } } },
    ])
    const hits = await harness.index.query(PROJECT, '支付回调')
    expect(hits.ok && hits.value[0]?.seq).toBe(5)
  })

  it('rebuild 落盘 index.json；删除索引文件后查询仍正确（派生投影）', async () => {
    const harness = await createHarness()
    await seed(harness)
    const rebuilt = await harness.index.rebuild(PROJECT)
    expect(rebuilt.ok && rebuilt.value.documents).toBeGreaterThan(0)
    expect(rebuilt.ok && rebuilt.value.builtAt).toBe('2026-09-15T00:00:00.000Z')
    expect(await harness.fileStore.exists('data/projects/p_1/search-index/index.json')).toBe(true)

    // 损坏/删除索引 → 下次查询应自动重建（不报错、不漏结果）
    await harness.fileStore.remove('data/projects/p_1/search-index/index.json')
    const hits = await harness.index.query(PROJECT, '登录模块')
    expect(hits.ok && hits.value.length).toBeGreaterThan(0)

    const stats = await harness.index.stats(PROJECT)
    expect(stats.ok && stats.value.documents).toBeGreaterThan(0)
  })

  it('索引文件损坏时按空索引重建（坏 JSON 不使查询失败）', async () => {
    const harness = await createHarness()
    await seed(harness)
    await harness.fileStore.writeTextAtomic('data/projects/p_1/search-index/index.json', '{ 坏索引')
    const hits = await harness.index.query(PROJECT, '登录模块')
    expect(hits.ok).toBe(true)
    expect(hits.ok && hits.value.length).toBeGreaterThan(0)
  })
})
