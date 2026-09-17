import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { createTestServer, type TestContext } from '../../helpers-server'
import { applyModelToAllTemplates, configureTestModel } from '../../helpers-model'
import { createIdGenerator } from '../../../src/infra/util/id'
import { ok, type Result } from '../../../src/shared/result'
import type { ModelChunk, ModelGateway, ModelInfo, ModelRequest } from '../../../src/ports/model'

/**
 * S37 复现：**回合正在跑的时候点「暂停」**。
 *
 * 缺陷（用户报告"暂停无效"）：
 * ① `setPaused` 与 `drain` 抢同一把 keyed lock，而 `drain` **持锁跑完整个队列**（含所有回合）→
 *    暂停请求要等 Agent 把队列全部干完才生效，等于"忙的时候暂停不了"；
 * ② drain 的 `for(;;)` 只在**入口**查一次 `paused`，回合被中断后**继续取下一条队列消息**；
 * ③ 被中断的回合照样推进游标 → 与 S4/S8/规则 26 的"暂停：游标不推进、消息留在队列、恢复补处理"不符。
 */

/** 可控网关：第 1 次调用"卡住"直到测试放行，用来稳定制造"回合正在生成"的窗口 */
function createGatedGateway(): {
  readonly gateway: ModelGateway
  readonly waitStarted: () => Promise<void>
  readonly release: () => void
  readonly abortedDuringCall: () => boolean
  readonly calls: () => number
} {
  const ids = createIdGenerator()
  let releaseFirst: () => void = () => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let markStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  let calls = 0
  /** 中断信号是否在**模型调用途中**就到达（＝暂停没有排队等锁） */
  let abortedEarly = false

  const models: readonly ModelInfo[] = [
    { id: 'gated', providerId: 'gated', model: 'gated', displayName: 'Gated（替身）', capabilities: ['chat', 'stream', 'tools'], enabled: true },
  ]

  return {
    gateway: {
      async stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
        calls += 1
        const index = calls
        void ids
        if (index === 1) {
          if (request.signal.aborted) abortedEarly = true
          request.signal.addEventListener('abort', () => {
            abortedEarly = true
          })
        }
        return ok(
          (async function* (): AsyncGenerator<ModelChunk> {
            if (index === 1) {
              markStarted()
              await firstGate
            }
            yield { type: 'text-delta', text: `第 ${index} 次生成` }
          })(),
        )
      },
      async listModels(): Promise<readonly ModelInfo[]> {
        return models
      },
    },
    waitStarted: () => started,
    release: () => releaseFirst(),
    abortedDuringCall: () => abortedEarly,
    calls: () => calls,
  }
}

interface AgentStatusBody {
  instanceId: string
  state: string
  paused: boolean
  queued: number
}

interface LogEvent {
  kind: string
  turn: number
  payload: Record<string, unknown>
}

describe('API · 暂停/停止的中断语义（S37）', () => {
  let context: TestContext
  let projectId: string
  let gated: ReturnType<typeof createGatedGateway>

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-pause-'))
    gated = createGatedGateway()
    context = await createTestServer({ gateway: gated.gateway })
    await configureTestModel(context.deps, { providerId: 's37-provider', modelId: 's37-model' })
    await applyModelToAllTemplates(context.app, 's37-model')
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '暂停中断演示', workdir },
    })
    projectId = created.json<{ id: string }>().id
    await context.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/pm_1`,
      payload: { loop: { strategy: 'direct', params: { maxIterations: 1 } } },
    })
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  const statusOf = async (instanceId: string): Promise<AgentStatusBody | undefined> => {
    const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    return response.json<AgentStatusBody[]>().find((item) => item.instanceId === instanceId)
  }

  const logOf = async (sessionId: string): Promise<LogEvent[]> => {
    const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/${sessionId}/log` })
    return response.json<LogEvent[]>()
  }

  it('回合中途暂停：立刻中断、不再续跑队列、游标不推进（恢复后补处理）', async () => {
    // ① 第一条消息会在模型调用里停住（不 await：这个请求要等整个回合跑完）
    const inflight = inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '第一条：写一段长文' },
    })
    await gated.waitStarted()

    // ② 再发一条 → 忙，入队
    const second = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '第二条：排队等着' },
    })
    expect(second.statusCode).toBe(202)
    expect(second.json<{ queued: boolean }>().queued).toBe(true)

    // ③ 暂停：先让请求进入（登记暂停意图 + abort 当前回合），再放行被卡住的模型调用
    const pausing = inject({ method: 'POST', url: `/api/projects/${projectId}/agents/pm_1/pause` })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // ④ 中断信号必须**立刻**送到在途回合（而不是等 drain 释放锁——那正是"暂停无效"的根因）
    expect(gated.abortedDuringCall()).toBe(true)

    gated.release()
    const pausedResponse = await pausing
    expect(pausedResponse.statusCode).toBe(200)
    await inflight

    // ⑤ 中断事实落进会话日志（S21/D27：Agent 靠日志自查被中断）
    const aborted = (await logOf('u_pm_1')).find(
      (event) => event.kind === 'state' && event.payload['turnAborted'] === true,
    )
    expect(aborted?.payload['reason']).toBe('pause')

    // ⑥ 队列没被续跑：只有 1 个回合；被中断的那条 + 排队的 1 条都还在队列（游标不推进）
    expect(gated.calls()).toBe(1)
    expect((await logOf('u_pm_1')).filter((event) => event.kind === 'turn_start')).toHaveLength(1)
    expect(await statusOf('pm_1')).toMatchObject({ state: 'idle', paused: true, queued: 2 })

    // ⑦ 恢复 → 补处理队列（FR-33 / 规则 26：恢复后继续处理队列）
    const resumed = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/pm_1/resume` })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json<{ handled: number }>().handled).toBe(2)
    expect((await logOf('u_pm_1')).filter((event) => event.kind === 'turn_start')).toHaveLength(3)
    expect(await statusOf('pm_1')).toMatchObject({ state: 'idle', paused: false, queued: 0 })
  })

  it('停止生成（无在途回合）：如实回 aborted=false，不假装停过', async () => {
    const stopped = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/pm_1/stop`,
      payload: { scope: 'turn' },
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json<{ aborted: boolean }>().aborted).toBe(false)
  })
})
