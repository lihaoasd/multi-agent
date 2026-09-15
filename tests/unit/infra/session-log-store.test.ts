import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createSessionLogStore } from '../../../src/infra/file-store/session-log-store'
import { createSessionMetaStore } from '../../../src/infra/file-store/session-meta-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import type { ProjectId } from '../../../src/ports/project'
import type { NewEvent, SessionId } from '../../../src/ports/session'
import { createSessionMeta } from '../../../src/application/session/session-meta-factory'

const PROJECT: ProjectId = 'p_1'
const SESSION: SessionId = 'u_dev_1'

async function createStores(maxLinesPerSegment = 50_000): Promise<{
  logStore: ReturnType<typeof createSessionLogStore>
  metaStore: ReturnType<typeof createSessionMetaStore>
  fileStore: ReturnType<typeof createFileStore>
}> {
  const root = mkdtempSync(join(tmpdir(), 'ah-log-'))
  const fileStore = createFileStore({ root })
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const metaStore = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
  const logStore = createSessionLogStore({
    fileStore,
    metaStore,
    lock: createKeyedLockManager(),
    clock,
    dataDir: 'data',
    maxLinesPerSegment,
  })
  await metaStore.create(createSessionMeta({ sessionId: SESSION, projectId: PROJECT, instanceId: 'dev_1', nowIso: '2026-09-15T00:00:00.000Z' }))
  return { logStore, metaStore, fileStore }
}

function message(text: string, turn = 1): NewEvent {
  return { kind: 'message', turn, payload: { role: 'user', text, content: { text } } }
}

describe('infra/session-log-store', () => {
  it('追加事件分配连续 seq 并更新 meta（lastSeq/segments）', async () => {
    const { logStore, metaStore } = await createStores()
    const first = await logStore.append(PROJECT, SESSION, [message('一'), message('二')])
    expect(first.ok && first.value.map((event) => event.seq)).toEqual([1, 2])
    expect(first.ok && first.value[0]?.ts).toBe('2026-09-15T00:00:00.000Z')

    const second = await logStore.append(PROJECT, SESSION, [{ kind: 'turn_start', turn: 1, payload: {} }])
    expect(second.ok && second.value[0]?.seq).toBe(3)

    const meta = await metaStore.get(PROJECT, SESSION)
    expect(meta.ok && meta.value.lastSeq).toBe(3)
    expect(meta.ok && meta.value.segments[0]?.file).toBe('u_dev_1.log.jsonl')
    expect(meta.ok && meta.value.segments[0]?.lines).toBe(3)
  })

  it('读窗口：fromSeq 过滤 + limit 取尾窗；按 kind 过滤', async () => {
    const { logStore } = await createStores()
    await logStore.append(PROJECT, SESSION, [message('一'), { kind: 'thought', turn: 1, payload: { text: '想' } }, message('二')])

    const all = await logStore.readWindow(PROJECT, SESSION)
    expect(all.ok && all.value.map((event) => event.seq)).toEqual([1, 2, 3])

    const from2 = await logStore.readWindow(PROJECT, SESSION, { fromSeq: 2 })
    expect(from2.ok && from2.value.map((event) => event.seq)).toEqual([2, 3])

    const tail = await logStore.readWindow(PROJECT, SESSION, { limit: 2 })
    expect(tail.ok && tail.value.map((event) => event.seq)).toEqual([2, 3])

    const messages = await logStore.readKinds(PROJECT, SESSION, ['message'])
    expect(messages.ok && messages.value.map((event) => event.seq)).toEqual([1, 3])
  })

  it('逐行容错：坏行被跳过，不影响其它事件（data-storage §9）', async () => {
    const { logStore, fileStore } = await createStores()
    await logStore.append(PROJECT, SESSION, [message('一')])
    await fileStore.appendLine('data/projects/p_1/sessions/u_dev_1.log.jsonl', '{ 这不是 JSON')
    await fileStore.appendLine('data/projects/p_1/sessions/u_dev_1.log.jsonl', '')

    const events = await logStore.readWindow(PROJECT, SESSION)
    expect(events.ok && events.value.map((event) => event.seq)).toEqual([1])
  })

  it('轮转：超阈值后归档当前段并开新段，seq 跨段仍单调连续', async () => {
    const { logStore, metaStore, fileStore } = await createStores(3)
    await logStore.append(PROJECT, SESSION, [message('1'), message('2'), message('3')])
    // 第 3 条写入后触发轮转
    const metaAfterRotate = await metaStore.get(PROJECT, SESSION)
    expect(metaAfterRotate.ok && metaAfterRotate.value.segments.map((segment) => segment.file)).toEqual([
      'u_dev_1.log.1.jsonl',
      'u_dev_1.log.jsonl',
    ])
    expect(await fileStore.exists('data/projects/p_1/sessions/u_dev_1.log.1.jsonl')).toBe(true)

    const more = await logStore.append(PROJECT, SESSION, [message('4')])
    expect(more.ok && more.value[0]?.seq).toBe(4)

    const all = await logStore.readWindow(PROJECT, SESSION)
    expect(all.ok && all.value.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const meta = await metaStore.get(PROJECT, SESSION)
    expect(meta.ok && meta.value.segments[1]?.lines).toBe(1)
  })

  it('并发追加不串号（KeyedLock 串行分配 seq）', async () => {
    const { logStore } = await createStores()
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => logStore.append(PROJECT, SESSION, [message(`并发 ${index}`)])),
    )
    const events = await logStore.readWindow(PROJECT, SESSION)
    expect(events.ok).toBe(true)
    if (!events.ok) return
    const seqs = events.value.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(10)
  })

  it('会话不存在 → ERR_NOT_FOUND（不静默创建）', async () => {
    const { logStore } = await createStores()
    const missing = await logStore.append(PROJECT, 'u_ghost_1', [message('x')])
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ERR_NOT_FOUND')
  })
})

describe('infra/session-meta-store', () => {
  it('解析非法 meta → ERR_VALIDATION；坏文件从列表跳过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-meta-'))
    const fileStore = createFileStore({ root })
    const clock = createFixedClock()
    const store = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
    await fileStore.ensureDir('data/projects/p_1/sessions')
    await fileStore.writeTextAtomic('data/projects/p_1/sessions/u_bad.meta.json', '{ bad')
    const listed = await store.list('p_1')
    expect(listed.ok && listed.value).toEqual([])
  })

  it('update 修改状态并刷新 updatedAt', async () => {
    const { metaStore } = await createStores()
    const updated = await metaStore.update(PROJECT, SESSION, (meta) => ({ ok: true, value: { ...meta, state: 'archived' } }))
    expect(updated.ok && updated.value.state).toBe('archived')
  })
})
