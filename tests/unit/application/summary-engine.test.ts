import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryService } from '../../../src/application/memory/memory-service'
import { createSummaryEngine, digestToText } from '../../../src/application/memory/summary-engine'
import { createEventPipeline } from '../../../src/application/session/event-pipeline'
import { createSessionMeta } from '../../../src/application/session/session-meta-factory'
import { createSessionService } from '../../../src/application/session/session-service'
import { createEnvConfigProvider } from '../../../src/infra/config/env-config'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createMemoryStore } from '../../../src/infra/file-store/memory-store'
import { createProjectStore } from '../../../src/infra/file-store/project-store'
import { createSessionLogStore } from '../../../src/infra/file-store/session-log-store'
import { createSessionMetaStore } from '../../../src/infra/file-store/session-meta-store'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import type { ModelChunk, ModelGateway } from '../../../src/ports/model'
import { createTestLogger } from '../../helpers'
import { DEFAULT_APP_CONFIG } from '../../../src/shared/config'
import { err, ok } from '../../../src/shared/result'

const PROJECT = 'p_1'
const SESSION = 'u_dev_1'

interface Harness {
  readonly engine: ReturnType<typeof createSummaryEngine>
  readonly sessions: ReturnType<typeof createSessionService>
  readonly memory: ReturnType<typeof createMemoryService>
  readonly model: { value: string | null; fail: boolean; calls: number }
}

async function createHarness(): Promise<Harness> {
  const fileStore = createFileStore({ root: mkdtempSync(join(tmpdir(), 'ah-summary-')) })
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const lock = createKeyedLockManager()
  const config = createEnvConfigProvider(DEFAULT_APP_CONFIG)
  const metaStore = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
  const logStore = createSessionLogStore({ fileStore, metaStore, lock, clock, dataDir: 'data' })
  const memoryStore = createMemoryStore({ fileStore, lock, clock, dataDir: 'data' })
  const projectStore = createProjectStore({ fileStore, lock, clock, dataDir: 'data' })
  await metaStore.create(
    createSessionMeta({ sessionId: SESSION, projectId: PROJECT, instanceId: 'dev_1', nowIso: '2026-09-15T00:00:00.000Z' }),
  )
  const pipeline = createEventPipeline({
    logStore,
    broadcaster: { broadcast: () => undefined },
    clock,
  })
  const sessions = createSessionService({ metaStore, logStore, pipeline, projectStore, clock })
  const memory = createMemoryService({ store: memoryStore, ids: createIdGenerator(), clock, config })
  const model = { value: 'mock' as string | null, fail: false, calls: 0 }

  const gateway: ModelGateway = {
    async stream() {
      model.calls += 1
      if (model.fail) return err('ERR_MODEL', '模型不可用')
      const chunks: readonly ModelChunk[] = [
        {
          type: 'text-delta',
          text: '```json\n{"topic":"登录模块","decisions":["采用 JWT"],"todos":["补测试"],"facts":["接口已定"]}\n```',
        },
      ]
      return ok(
        (async function* () {
          for (const chunk of chunks) yield chunk
        })(),
      )
    },
    async listModels() {
      return []
    },
  }

  return {
    sessions,
    memory,
    model,
    engine: createSummaryEngine({
      sessions,
      memory,
      gateway,
      resolveModel: async () => ok(model.value),
      lock,
      ids: createIdGenerator(),
      clock,
      config,
      logger: createTestLogger(),
    }),
  }
}

async function appendMessages(harness: Harness, count: number, from: number): Promise<void> {
  const events = Array.from({ length: count }, (_, index) => {
    const seq = from + index
    const text = `需求第 ${seq} 条：继续推进登录模块`
    return { kind: 'message' as const, turn: 1, payload: { role: 'user', text, content: { text } } }
  })
  const appended = await harness.sessions.append(PROJECT, SESSION, events)
  if (!appended.ok) throw new Error(appended.error.message)
}

/** 规则 6：滚动摘要（L2）的阈值、可重放连续性与 L3 提取 */
describe('application/summary-engine · 滚动摘要（规则 6）', () => {
  it('不足阈值不调模型、不写事件', async () => {
    const harness = await createHarness()
    await appendMessages(harness, 10, 1)
    const outcome = await harness.engine.maintain(PROJECT, SESSION)
    expect(outcome.ok && outcome.value.summarized).toBe(false)
    expect(outcome.ok && outcome.value.reason).toBe('below-threshold')
    expect(harness.model.calls).toBe(0)

    const history = await harness.sessions.window(PROJECT, SESSION)
    expect(history.ok && history.value.some((event) => event.kind === 'summary')).toBe(false)
  })

  it('达到 40 条消息生成 summary 事件：ofSeq/toSeq 覆盖窗口，并提取一条角色记忆', async () => {
    const harness = await createHarness()
    await appendMessages(harness, 40, 1)

    const outcome = await harness.engine.maintain(PROJECT, SESSION, { turn: 1 })
    expect(outcome.ok && outcome.value.summarized).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toMatchObject({ ofSeq: 1, toSeq: 40, coveredMessages: 40, reason: null })

    const history = await harness.sessions.window(PROJECT, SESSION)
    expect(history.ok).toBe(true)
    if (!history.ok) return
    const summary = history.value.find((event) => event.kind === 'summary')
    expect(summary?.payload).toMatchObject({ summaryId: outcome.value.summaryId, ofSeq: 1, toSeq: 40, model: 'mock' })
    expect(summary?.payload['digest']).toMatchObject({ topic: '登录模块', decisions: ['采用 JWT'] })

    const memories = await harness.memory.list(PROJECT, { scope: 'agent', instanceId: 'dev_1' })
    expect(memories.ok && memories.value).toHaveLength(1)
    expect(memories.ok && memories.value[0]?.type).toBe('progress')
    expect(memories.ok && memories.value[0]?.content).toContain('采用 JWT')
  })

  it('可重放且不重叠：窗口耗尽 → no-messages；新增满窗口 → ofSeq 接在上一条 toSeq 之后', async () => {
    const harness = await createHarness()
    await appendMessages(harness, 40, 1)
    await harness.engine.maintain(PROJECT, SESSION)

    const again = await harness.engine.maintain(PROJECT, SESSION)
    expect(again.ok && again.value).toMatchObject({ summarized: false, reason: 'no-messages' })

    await appendMessages(harness, 40, 41)
    const second = await harness.engine.maintain(PROJECT, SESSION)
    // 第一条 summary 事件本身占了 seq 41，故新窗口从 42 开始（仍严格接在 toSeq=40 之后）
    expect(second.ok && second.value).toMatchObject({ summarized: true, ofSeq: 42, toSeq: 81 })

    const history = await harness.sessions.window(PROJECT, SESSION)
    expect(history.ok).toBe(true)
    if (!history.ok) return
    const refs = history.value
      .filter((event) => event.kind === 'summary')
      .map((event) => ({ ofSeq: event.payload['ofSeq'] as number, toSeq: event.payload['toSeq'] as number }))
    expect(refs).toEqual([
      { ofSeq: 1, toSeq: 40 },
      { ofSeq: 42, toSeq: 81 },
    ])
    // 连续无重叠
    expect(refs[1]?.ofSeq).toBeGreaterThan(refs[0]?.toSeq ?? 0)
  })

  it('该角色没有可用模型时不摘要（no-model），且不写事件', async () => {
    const harness = await createHarness()
    harness.model.value = null
    await appendMessages(harness, 40, 1)

    const outcome = await harness.engine.maintain(PROJECT, SESSION)
    expect(outcome.ok && outcome.value).toMatchObject({ summarized: false, reason: 'no-model' })
    expect(harness.model.calls).toBe(0)
  })

  it('模型调用失败不阻断回合：记为 model-failed 且不写 summary 事件', async () => {
    const harness = await createHarness()
    harness.model.fail = true
    await appendMessages(harness, 40, 1)

    const outcome = await harness.engine.maintain(PROJECT, SESSION)
    expect(outcome.ok && outcome.value).toMatchObject({ summarized: false, reason: 'model-failed' })
    const history = await harness.sessions.window(PROJECT, SESSION)
    expect(history.ok && history.value.some((event) => event.kind === 'summary')).toBe(false)
  })

  it('digestToText：结构化摘要拼成人类可读文本（供注入与记忆条目）', () => {
    expect(
      digestToText({
        topic: '登录',
        goals: [],
        decisions: ['采用 JWT'],
        facts: ['接口已定'],
        todos: ['补测试'],
        questions: [],
        text: null,
      }),
    ).toBe('主题：登录\n已定结论：采用 JWT\n关键信息：接口已定\n待办：补测试')
  })
})
