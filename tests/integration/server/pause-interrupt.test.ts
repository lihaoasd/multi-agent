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
 * S49/D52：**暂停的语义**（用户口径："每个 agent 执行完一轮 loop 后，判断是否是暂停，
 * 如果是就停止循环，生成已经停止"）。
 *
 * 与 S37 的差别：暂停**不再中途切断在途模型调用**，而是在**每一轮 loop 开始处**检查暂停意图——
 * 当前这一轮跑完就跳出循环。用例用一个"卡住第一次模型调用"的网关把这一轮拉长，期间按下暂停再放行：
 * ① 在途模型调用**没有被切断**（`abortedDuringCall` 为 false）；
 * ② 循环**停在下一轮之前**（本轮要求调工具 → 正常会再来一轮；暂停后总调用数仍为 1）；
 * ③ 游标**不推进**（被中断那条消息留在队列，`resume` 后补处理）；
 * ④ 会话日志里留下"暂停"事实（`state{paused:true}`，供 Agent 按 S21/D27 自查）。
 */

interface GatedGateway {
  readonly gateway: ModelGateway
  readonly waitStarted: () => Promise<void>
  readonly release: () => void
  readonly abortedDuringCall: () => boolean
  readonly calls: () => number
}

function createGatedGateway(): GatedGateway {
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
  let abortedEarly = false
  const models: readonly ModelInfo[] = [
    {
      id: 'gated',
      providerId: 'gated',
      model: 'gated',
      displayName: 'Gated（替身）',
      capabilities: ['chat', 'stream', 'tools'],
      enabled: true,
    },
  ]
  return {
    gateway: {
      async stream(request: ModelRequest): Promise<Result<AsyncIterable<ModelChunk>>> {
        calls += 1
        const index = calls
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
            // 每一轮都"要调一次工具"：正常情况会进入下一轮 loop；暂停后应停在下一轮之前
            yield { type: 'tool-call', callId: ids.next('call'), name: 'session_recent', args: { limit: 3 } }
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

interface StatusBody {
  instanceId: string
  state: string
  paused: boolean
  queued: number
}

interface LogEvent {
  kind: string
  payload: Record<string, unknown>
}

describe('API · 暂停在轮次边界生效（S49/D52）', () => {
  let context: TestContext
  let projectId: string
  let gated: GatedGateway

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-pause-loop-'))
    gated = createGatedGateway()
    context = await createTestServer({ gateway: gated.gateway })
    await configureTestModel(context.deps, { providerId: 's49-provider', modelId: 's49-model' })
    await applyModelToAllTemplates(context.app, 's49-model')
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '暂停轮次边界演示', workdir },
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

  const statusOf = async (instanceId: string): Promise<StatusBody | undefined> => {
    const response = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    return response.json<StatusBody[]>().find((item) => item.instanceId === instanceId)
  }

  const logOf = async (): Promise<LogEvent[]> => {
    const response = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_pm_1/log` })
    return response.json<LogEvent[]>()
  }

  const waitFor = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> => {
    const startedAt = Date.now()
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('暂停：当前一轮跑完即停止循环（不切断模型调用），游标不推进，恢复后补处理', async () => {
    // ① 第一条消息会让回合停在被卡住的模型调用里；第二条消息入队
    const inflight = inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '第一条：写一段长文' },
    })
    await gated.waitStarted()
    const second = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '第二条：排队等着' },
    })
    expect(second.json<{ queued: boolean }>().queued).toBe(true)

    // ② 暂停：登记意图（**不 abort**）
    const pausing = inject({ method: 'POST', url: `/api/projects/${projectId}/agents/pm_1/pause` })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(gated.abortedDuringCall()).toBe(false) // ← S49/D52：在途模型调用不被切断

    // ③ 放行这一轮：模型要调工具（session_recent）→ 正常会进入下一轮；暂停后应停在下一轮之前
    gated.release()
    const pausedResponse = await pausing
    expect(pausedResponse.statusCode).toBe(200)
    await inflight

    expect(gated.calls()).toBe(1)
    expect((await logOf()).filter((event) => event.kind === 'turn_start')).toHaveLength(1)
    const marker = (await logOf()).find((event) => event.kind === 'state' && event.payload['paused'] === true)
    expect(marker).toBeDefined()
    // 两条消息都还在队列（被中断那条不推进游标）
    expect(await statusOf('pm_1')).toMatchObject({ state: 'idle', paused: true, queued: 2 })

    // ④ 恢复 → 两条都补处理；每轮都"要再调工具" ⇒ 每条消息跑满 direct 的 1 + MAX_TOOL_ROUNDS(4) = 5 次调用
    //    （对比：暂停那次只跑了 1 次调用——循环确实停在了下一轮之前，也说明不暂停时循环会照常继续）
    const resumed = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/pm_1/resume` })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json<{ handled: number }>().handled).toBe(2)
    await waitFor(async () => ((await statusOf('pm_1'))?.queued === 0 ? true : null), '队列清空')
    expect(gated.calls()).toBe(1 + 2 * 5)
    expect((await logOf()).filter((event) => event.kind === 'turn_start')).toHaveLength(3)
  })

  it('停止生成接口仍在（界面入口已移除，S49/D52）：无在途回合时如实回 aborted=false', async () => {
    const stopped = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/pm_1/stop`,
      payload: { scope: 'turn' },
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json<{ aborted: boolean }>().aborted).toBe(false)
  })
})
