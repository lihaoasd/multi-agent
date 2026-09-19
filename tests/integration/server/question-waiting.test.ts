import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import { applyModelToAllTemplates, configureTestModel } from '../../helpers-model'
import { createScriptedGateway } from '../../helpers-scripted-gateway'
import type { QuestionRecord } from '../../../src/ports/question'

/**
 * S38/D41 端到端：Agent 用 `ask_user` 询问时，**状态投影**必须说清"在等用户答复"
 * （`state='waiting'` + `waitingFor='question'`），答复后回到空闲。
 *
 * 用户口径："角色询问，应该是等待回复中"——`waiting` 只说"卡住了"，
 * 界面要能区分「等答复」与「等审批」（`waitingFor`）。
 */
describe('API · 询问等待的状态投影（S38/D41）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-ask-'))
    const gateway = createScriptedGateway([
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('开始回归')),
        toolCalls: [
          {
            name: 'ask_user',
            args: { title: '回归范围选哪个？', items: [{ text: '范围', options: ['全量', '核心'] }] },
          },
        ],
      },
      { text: '已按选择继续。' },
    ])
    context = await createTestServer({ gateway })
    await configureTestModel(context.deps, { providerId: 's38-provider', modelId: 's38-model' })
    await applyModelToAllTemplates(context.app, 's38-model')
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '询问等待演示', workdir },
    })
    projectId = created.json<{ id: string }>().id
    await context.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/qa_1`,
      payload: { loop: { strategy: 'direct', params: { maxIterations: 1 } } },
    })
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const statusOf = async (instanceId: string): Promise<Record<string, unknown> | undefined> => {
    const response = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    return response.json<Array<Record<string, unknown>>>().find((item) => item['instanceId'] === instanceId)
  }

  const waitFor = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('询问期间 state=waiting / waitingFor=question，答复后回 idle / null', async () => {
    // 回合会卡在"等答复"上，所以这个请求要等答复后才返回
    const inflight = context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_qa_1/messages`,
      payload: { text: '开始回归' },
    })

    const waiting = await waitFor(async () => {
      const status = await statusOf('qa_1')
      return status?.['state'] === 'waiting' ? status : null
    }, '进入等待答复')
    expect(waiting).toMatchObject({ state: 'waiting', waitingFor: 'question' })

    // 答复入口是会话窗口（S32/D35），这里直接打接口，验状态收敛
    const pending = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/questions?status=pending` })
    const question = pending.json<QuestionRecord[]>()[0]
    expect(question?.asker).toBe('qa_1')
    if (question === undefined) throw new Error('缺少待答复询问')
    const answered = await context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/questions/${question.id}/answer`,
      payload: { answers: [{ itemId: 'i_1', choice: '全量' }] },
    })
    expect(answered.statusCode).toBe(200)

    await inflight
    const idle = await waitFor(async () => {
      const status = await statusOf('qa_1')
      return status?.['state'] === 'idle' ? status : null
    }, '回到空闲')
    expect(idle).toMatchObject({ state: 'idle', waitingFor: null, paused: false, queued: 0 })
  })
})
