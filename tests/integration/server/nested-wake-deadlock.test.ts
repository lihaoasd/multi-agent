import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import { applyModelToAllTemplates, configureTestModel } from '../../helpers-model'
import type { ModelChunk, ModelGateway, ModelInfo, ModelRequest } from '../../../src/ports/model'
import type { TaskRecord } from '../../../src/ports/task'
import { createIdGenerator } from '../../../src/infra/util/id'
import { ok } from '../../../src/shared/result'

/**
 * S47 回归：**嵌套唤醒死锁**。
 *
 * 链路（真实发生过的形态）：
 * ① pm_1 调 `task_assign` → 平台通知并**唤醒**受派人 → `wake` 里 `await dispatcher.drain(dev_1)`
 *    → dev_1 的整个回合**跑在 pm_1 的回合内**（`drain` 持 `agent:pm_1` 锁不释放）；
 * ② dev_1 回合里 `task_update` 汇报 → 平台通知并唤醒**委派人 pm_1**
 *    → `await dispatcher.drain(pm_1)` → 需要 `agent:pm_1` 锁，而它正被 ① 的外层 drain 持有、
 *    且 ① 又在等 dev_1 的回合结束 → **两个 Agent 互等，永久卡死**（keyed lock 无重入、无超时）。
 *
 * 现象就是用户报的"系统挂了 / 审批和询问都失效"：被卡住的 Agent 一直是"工作中"，
 * 后续消息、审批、询问都推不动。用例超时（15s）即代表旧行为复现。
 */
function createChainGateway(context: () => TestContext, projectId: () => string): ModelGateway {
  const ids = createIdGenerator()
  const models: readonly ModelInfo[] = [
    {
      id: 'chain',
      providerId: 'chain',
      model: 'chain',
      displayName: 'Chain（替身）',
      capabilities: ['chat', 'stream', 'tools'],
      enabled: true,
    },
  ]
  const firstTaskOf = async (): Promise<string | null> => {
    const tasks = await context().deps.tasks.list(projectId(), { assignee: 'dev_1' })
    return tasks.ok ? (tasks.value[0]?.id ?? null) : null
  }
  return {
    async stream(request: ModelRequest) {
      const all = request.messages.map((message) => message.content).join('\n')
      const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      const chunks: ModelChunk[] = []
      const call = (name: string, args: Record<string, unknown>): void => {
        chunks.push({ type: 'tool-call', callId: ids.next('call'), name, args })
      }
      const claimedRecently = all.lastIndexOf('已领取任务') > all.lastIndexOf('已汇报任务')
      if (lastUser.includes('已汇报任务')) {
        // 委派人被唤醒：据此继续——这一步在旧实现里永远到不了（它的回合正等 dev_1，而 dev_1 的汇报在等它）
        chunks.push({ type: 'text-delta', text: '已收到回报，继续推进下一步' })
      } else if (lastUser.includes('待领取任务')) {
        const taskId = await firstTaskOf()
        if (taskId === null) chunks.push({ type: 'text-delta', text: '没有待领取任务' })
        else call('task_claim', { taskId })
      } else if (claimedRecently) {
        // 刚领取完（同一回合的追问）：汇报 done —— 这一步会唤醒 pm_1，旧实现即死锁点
        const taskId = await firstTaskOf()
        if (taskId === null) chunks.push({ type: 'text-delta', text: '没有可汇报的任务' })
        else call('task_update', { taskId, state: 'done', note: '已实现并自测' })
      } else if (lastUser.includes('开始吧')) {
        call('task_assign', { assignee: 'dev_1', title: '实现登录模块', desc: '按 PRD 实现' })
      } else {
        chunks.push({ type: 'text-delta', text: '本步骤完成' })
      }
      return ok(
        (async function* (): AsyncGenerator<ModelChunk> {
          for (const chunk of chunks) yield chunk
        })(),
      )
    },
    async listModels(): Promise<readonly ModelInfo[]> {
      return models
    },
  }
}

describe('API · 嵌套唤醒不再死锁（S47）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-chain-'))
    let ctx: TestContext | null = null
    const gateway = createChainGateway(
      () => {
        if (ctx === null) throw new Error('测试上下文尚未就绪')
        return ctx
      },
      () => projectId,
    )
    context = await createTestServer({ gateway })
    ctx = context
    await configureTestModel(context.deps, { providerId: 's47-provider', modelId: 's47-model' })
    await applyModelToAllTemplates(context.app, 's47-model')
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '嵌套唤醒演示', workdir },
    })
    projectId = created.json<{ id: string }>().id
    // pm_1 → dev_1 的委派边
    const graph = (
      await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    ).json<{ version: number; nodes: readonly unknown[] }>()
    await context.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: { version: graph.version, nodes: graph.nodes, edges: [{ from: 'pm_1', to: 'dev_1' }] },
    })
    for (const instanceId of ['pm_1', 'dev_1']) {
      await context.app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/team/${instanceId}`,
        payload: { loop: { strategy: 'direct', params: { maxIterations: 1 } } },
      })
    }
  }, 20_000)

  afterAll(async () => {
    await context.cleanup()
  })

  const waitFor = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 12_000): Promise<T> => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it(
    '委派人派单 → 受派人汇报 → 委派人被唤醒并继续（不互相卡死）',
    async () => {
      // 用户给 pm_1 一条消息：pm 会 task_assign 给 dev_1，dev_1 被唤醒后汇报，PM 再被唤醒继续
      const inflight = context.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
        payload: { text: '开始吧' },
      })

      // ① 受派人把任务干完并汇报（旧实现在这里会卡住：它的汇报要唤醒 pm_1，而 pm_1 的回合正等它）
      const done = await waitFor(async () => {
        const list = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?state=done` })
        return list.json<TaskRecord[]>()[0] ?? null
      }, '任务被汇报为 done')
      expect(done.note).toBe('已实现并自测')

      // ② 委派人确实收到了回报**并继续执行**——这一步跨过了旧实现的死锁点
      await waitFor(async () => {
        const log = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_pm_1/log` })
        const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
        const noticeIndex = events.findIndex(
          (event) => event.kind === 'message' && String(event.payload['text'] ?? '').includes('已汇报任务'),
        )
        if (noticeIndex < 0) return null
        const continued = events
          .slice(noticeIndex + 1)
          .some((event) => event.kind === 'message' && event.payload['role'] === 'agent')
        return continued ? true : null
      }, '委派人收到回报并继续')

      await inflight

      // ③ 两个 Agent 都应回到空闲（没有互相卡住）
      const statuses = await waitFor(async () => {
        const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
        const list = response.json<Array<{ instanceId: string; state: string }>>()
        const pm = list.find((item) => item.instanceId === 'pm_1')
        const dev = list.find((item) => item.instanceId === 'dev_1')
        return pm?.state === 'idle' && dev?.state === 'idle' ? list : null
      }, '两个 Agent 回到空闲')
      expect(statuses.find((item) => item.instanceId === 'dev_1')?.state).toBe('idle')
    },
    25_000,
  )
})
