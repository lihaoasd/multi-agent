import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEventPipeline } from '../../../src/application/session/event-pipeline'
import { createSessionMeta } from '../../../src/application/session/session-meta-factory'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createSessionLogStore } from '../../../src/infra/file-store/session-log-store'
import { createSessionMetaStore } from '../../../src/infra/file-store/session-meta-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createRecordingEventBroadcaster } from '../../../src/infra/events/noop-broadcaster'
import { createFixedClock } from '../../../src/infra/util/system-clock'

const PROJECT = 'p_1'
const SESSION = 'u_dev_1'
const LOG_PATH = 'data/projects/p_1/sessions/u_dev_1.log.jsonl'

async function setup(): Promise<{
  pipeline: ReturnType<typeof createEventPipeline>
  broadcaster: ReturnType<typeof createRecordingEventBroadcaster>
  fileStore: ReturnType<typeof createFileStore>
}> {
  const root = mkdtempSync(join(tmpdir(), 'ah-pipeline-'))
  const fileStore = createFileStore({ root })
  const clock = createFixedClock()
  const metaStore = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
  const logStore = createSessionLogStore({
    fileStore,
    metaStore,
    lock: createKeyedLockManager(),
    clock,
    dataDir: 'data',
  })
  await metaStore.create(
    createSessionMeta({ sessionId: SESSION, projectId: PROJECT, instanceId: 'dev_1', nowIso: '2026-09-15T00:00:00.000Z' }),
  )
  const broadcaster = createRecordingEventBroadcaster()
  const pipeline = createEventPipeline({ logStore, broadcaster, clock })
  return { pipeline, broadcaster, fileStore }
}

describe('application/session/event-pipeline（先盘后推，规则 5）', () => {
  it('落盘成功后才广播 event.appended；message 额外广播 message.commit', async () => {
    const { pipeline, broadcaster, fileStore } = await setup()
    const appended = await pipeline.append(PROJECT, SESSION, [
      { kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1' } },
      { kind: 'message', turn: 1, payload: { role: 'user', text: '你好' } },
    ])
    expect(appended.ok).toBe(true)

    const onDisk = await fileStore.readText(LOG_PATH)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) {
      const lines = onDisk.value.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ seq: 2, kind: 'message', text: '你好' })
    }

    const types = broadcaster.events().map((event) => event.type)
    expect(types).toEqual(['event.appended', 'event.appended', 'message.commit'])
    const payload = broadcaster.events()[0]?.payload
    expect(payload).toMatchObject({ projectId: PROJECT, sessionId: SESSION, seq: 1, kind: 'turn_start' })
  })

  it('落盘失败则不广播（先盘后推的顺序保证）', async () => {
    const { pipeline, broadcaster } = await setup()
    const failed = await pipeline.append(PROJECT, 'u_ghost_1', [{ kind: 'message', turn: 1, payload: { text: 'x' } }])
    expect(failed.ok).toBe(false)
    expect(broadcaster.events()).toEqual([])
  })

  it('空事件数组不产生任何写入与广播', async () => {
    const { pipeline, broadcaster, fileStore } = await setup()
    const result = await pipeline.append(PROJECT, SESSION, [])
    expect(result.ok && result.value).toEqual([])
    expect(broadcaster.events()).toEqual([])
    expect(await fileStore.exists(LOG_PATH)).toBe(false)
  })
})
