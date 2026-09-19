import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import { applyModelToAllTemplates, configureTestModel } from '../../helpers-model'
import { recoverOnStartup } from '../../../src/bootstrap/startup'
import { ok } from '../../../src/shared/result'
import type { ModelChunk, ModelGateway, ModelInfo, ModelRequest } from '../../../src/ports/model'

/**
 * S47 回归：**"系统挂了之后起不来"**。
 *
 * 两处缺口（用户报告："系统挂了，原有是审批和询问都失效"）：
 * ① **重启后不补处理排队消息**：启动自检只清残留占用，没人去 drain 那些已入队消息
 *    → Agent 无动作，用户以为"消息/审批/询问全失效"（D18-③ 早就承诺要补一轮）。
 * ② **审批决定没有等待者时不通知申请者**：等待者随进程消失（跨重启口径：pending 保持、回合不在），
 *    用户点"批准/拒绝"只落盘、没人被唤醒 → 表现为"审批点了没用"。
 *    （询问答复没有这个问题：`question-service.answer` 一直会 notify 唤醒提问者。）
 */
describe('API · 重启/无等待者时的恢复（S47）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-recover-'))
    // 架构师会提问（回合卡在等答复）；其它角色直接给结论——用于验证"一个卡住不挡别人"
    const gateway: ModelGateway = {
      async stream(request: ModelRequest) {
        const all = request.messages.map((message) => message.content).join('\n')
        const chunks: ModelChunk[] =
          // 注意：判据要用**角色提示词自己的句子**（`你是本项目的系统架构师`），
          // 不能用「架构师」三个字——S50 的「团队与可委派对象」块会把所有角色的描述注入每个 Agent 的提示词
          all.includes('你是本项目的系统架构师') && !all.includes('用户已回答')
            ? [
                {
                  type: 'tool-call',
                  callId: 'call_ask',
                  name: 'ask_user',
                  args: { title: '先定哪个方案？', items: [{ text: '方案', options: ['A', 'B'] }] },
                },
              ]
            : [{ type: 'text-delta', text: '收到，我来处理。' }]
        return ok(
          (async function* (): AsyncGenerator<ModelChunk> {
            for (const chunk of chunks) yield chunk
          })(),
        )
      },
      async listModels(): Promise<readonly ModelInfo[]> {
        return [
          {
            id: 'recover',
            providerId: 'recover',
            model: 'recover',
            displayName: 'Recover（替身）',
            capabilities: ['chat', 'stream', 'tools'],
            enabled: true,
          },
        ]
      },
    }
    context = await createTestServer({ gateway })
    await configureTestModel(context.deps, { providerId: 's47b-provider', modelId: 's47b-model' })
    await applyModelToAllTemplates(context.app, 's47b-model')
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '恢复演示', workdir },
    })
    projectId = created.json<{ id: string }>().id
    for (const instanceId of ['dev_1', 'qa_1', 'architect_1']) {
      await context.app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/team/${instanceId}`,
        payload: { loop: { strategy: 'direct', params: { maxIterations: 1 } } },
      })
    }
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const waitFor = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('启动自检补处理排队消息：只改暂停标记（模拟重启）后，队列里的消息会被真的处理', async () => {
    // 造出"重启后的状态"：有排队消息、无占用、未暂停
    // ① 暂停 → 发消息只入队（不处理）
    const paused = await context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/dev_1/pause`,
    })
    expect(paused.statusCode).toBe(200)
    const queued = await context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/messages`,
      payload: { text: '开始处理这条' },
    })
    expect(queued.json<{ queued: boolean }>().queued).toBe(true)

    // ② 只把暂停标记改回 false（直接调服务：不触发 drain）——相当于重启后"占用没了、队列还在"
    const resumedFlag = await context.deps.dispatcher.setPaused(projectId, 'dev_1', false)
    expect(resumedFlag.ok).toBe(true)

    // ③ 启动自检应当把这条消息补处理掉
    const recovered = await recoverOnStartup({
      project: context.deps.project,
      dispatcher: context.deps.dispatcher,
      logger: context.deps.logger,
    })
    expect(recovered.resumed).toContain(`${projectId}:dev_1`)

    const log = await waitFor(async () => {
      const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
      const events = response.json<Array<{ kind: string }>>()
      return events.some((event) => event.kind === 'turn_end') ? events : null
    }, '排队消息被处理（回合收尾）')
    expect(log.filter((event) => event.kind === 'turn_start')).toHaveLength(1)
    const statuses = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    const dev = statuses.json<Array<{ instanceId: string; queued: number }>>().find((item) => item.instanceId === 'dev_1')
    expect(dev?.queued).toBe(0)
  })

  it('审批决定没有等待者（进程重启过）时，也要唤醒申请者', async () => {
    // 直接落一条 pending 审批：进程内**没有** waitForDecision 等待者（正是重启后的形态）
    const created = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'dev_1',
      sessionId: 'u_dev_1',
      summary: '跑一条内联命令',
      detail: 'node -e "1"',
    })
    if (!created.ok) throw new Error('审批创建失败')

    const decided = await context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/approvals/${created.value.id}/decide`,
      payload: { decision: 'approved' },
    })
    expect(decided.statusCode).toBe(200)

    await waitFor(async () => {
      const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
      const events = response.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      return events.some(
        (event) => event.kind === 'message' && String(event.payload['text'] ?? '').includes('[审批] 你的申请已被批准'),
      )
        ? true
        : null
    }, '申请者被唤醒')
  })
  it('补处理时一个 Agent 卡在"等答复"，不能挡住其它 Agent（S47）', async () => {
    // 造重启态：architect_1 与 qa_1 各有一条排队消息，都未暂停、无占用
    for (const instanceId of ['architect_1', 'qa_1']) {
      await context.app.inject({ method: 'POST', url: `/api/projects/${projectId}/agents/${instanceId}/pause` })
      await context.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/sessions/u_${instanceId}/messages`,
        payload: { text: '开始处理这条' },
      })
      const flag = await context.deps.dispatcher.setPaused(projectId, instanceId, false)
      expect(flag.ok).toBe(true)
    }

    // 旧实现逐个 await drain：architect_1 的回合会卡在 ask_user 等待上，qa_1 永远轮不到
    const started = Date.now()
    const kicked = await context.deps.dispatcher.resumeQueued(projectId)
    expect(kicked.ok).toBe(true)
    if (!kicked.ok) return
    expect(kicked.value.resumed).toEqual(expect.arrayContaining(['architect_1', 'qa_1']))
    expect(Date.now() - started).toBeLessThan(5_000)

    // qa_1 的回合应当真的跑完（不被 architect_1 的等待拖住）
    await waitFor(async () => {
      const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_qa_1/log` })
      const events = response.json<Array<{ kind: string }>>()
      return events.some((event) => event.kind === 'turn_end') ? true : null
    }, 'qa_1 的排队消息被处理')

    // architect_1 则进入"等待回复中"，等用户在它自己的会话里作答（不影响别人）
    await waitFor(async () => {
      const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
      const architect = response
        .json<Array<{ instanceId: string; state: string; waitingFor: string | null }>>()
        .find((item) => item.instanceId === 'architect_1')
      return architect?.state === 'waiting' && architect.waitingFor === 'question' ? true : null
    }, 'architect_1 进入等待答复')
  })
})

/** 启动自检的接线（不可用时不该中断其它项目）——用替身钉住口径 */
describe('bootstrap · recoverOnStartup 接线', () => {
  it('逐项目清占用 + 补处理；单个项目失败不影响其它项目', async () => {
    const calls: string[] = []
    const result = await recoverOnStartup({
      project: {
        list: async () => ok([{ id: 'p_ok' }, { id: 'p_bad' }] as never),
      },
      dispatcher: {
        resetStaleOccupancy: async (projectId: string) => {
          calls.push(`reset:${projectId}`)
          return projectId === 'p_bad'
            ? { ok: false as const, error: { code: 'ERR_INTERNAL', message: 'boom' } }
            : ok(1)
        },
        resumeQueued: async (projectId: string) => {
          calls.push(`resume:${projectId}`)
          return ok({ resumed: projectId === 'p_ok' ? ['dev_1'] : [] })
        },
      },
      logger: { warn: () => undefined, info: () => undefined },
    })
    expect(calls).toEqual(['reset:p_ok', 'resume:p_ok', 'reset:p_bad', 'resume:p_bad'])
    expect(result.cleared).toBe(1)
    expect(result.resumed).toEqual(['p_ok:dev_1'])
  })
})
