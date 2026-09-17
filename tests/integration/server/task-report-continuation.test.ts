import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import { applyModelToAllTemplates, configureTestModel } from '../../helpers-model'
import { createScriptedGateway } from '../../helpers-scripted-gateway'
import type { TaskRecord } from '../../../src/ports/task'
import type { OrchestrationGraph } from '../../../src/ports/orchestration'

/**
 * S36/D39 端到端：受派人领取 → 执行 → 汇报 → **派发人收到回报并继续执行**。
 *
 * 用脚本化网关让"继续"变成可断言的行为（派发人真的发起新的 `task_assign`），
 * 而不是只断言一句文案——文案对了但 Agent 不动，用户的问题依然在。
 */
describe('API · 任务汇报闭环（S36/D39）：受派人汇报 → 派发人收到并继续', () => {
  let context: TestContext
  let projectId: string
  let taskId: string

  beforeAll(async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ah-task-loop-'))
    const gateway = createScriptedGateway([
      // ① 受派人收到"待领取"通知（唤醒一轮，本用例不断言）
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('待领取任务')),
        text: '收到待领取通知。',
      },
      // ② 派发人收到回报通知 → **据此继续**：沿自己在本项目的出边（pm_1 → dev_1）派下一步
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('已汇报任务')),
        toolCalls: [
          { name: 'task_assign', args: { assignee: 'dev_1', title: '补充登录模块自测用例', desc: '基于 dev_1 的回报推进' } },
        ],
      },
      { text: '已根据 dev_1 的回报安排下一步。' },
    ])
    context = await createTestServer({ gateway })
    await configureTestModel(context.deps, { providerId: 's36-provider', modelId: 's36-model' })
    await applyModelToAllTemplates(context.app, 's36-model')

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '任务闭环演示', workdir },
    })
    projectId = created.json<{ id: string }>().id

    // 让"一次模型调用即发起工具调用"的剧本确定可复现
    for (const instanceId of ['pm_1', 'dev_1']) {
      await context.app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/team/${instanceId}`,
        payload: { loop: { strategy: 'direct', params: { maxIterations: 1 } } },
      })
    }

    // 建图：pm_1 → dev_1 的委派边（铁律 2：Agent 只能沿自己的出边派单）
    const graph = (
      await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    ).json<OrchestrationGraph>()
    const saved = await context.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: { version: graph.version, nodes: graph.nodes, edges: [{ from: 'pm_1', to: 'dev_1' }] },
    })
    expect(saved.statusCode).toBe(200)

    // pm 沿出边派单给 dev：创建即通知受派人 → 唤醒 dev 一轮（剧本 ①）
    const assigned = await context.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      payload: { creator: 'pm_1', assignee: 'dev_1', title: '实现登录模块', desc: '按 PRD 实现并自测' },
    })
    taskId = (() => {
      if (assigned.statusCode !== 201) throw new Error(`派单失败 ${assigned.statusCode}：${assigned.body}`)
      return assigned.json<{ task: TaskRecord }>().task.id
    })()
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

  it('汇报 done 后派发人收到含"继续"的通知，并真的继续执行（发起下一步派单）', async () => {
    const claimed = await context.deps.tasks.claim(projectId, taskId, 'dev_1')
    expect(claimed.ok).toBe(true)
    const reported = await context.deps.tasks.setState(projectId, taskId, 'done', { actor: 'dev_1', note: '已实现并自测' })
    expect(reported.ok).toBe(true)

    // ① 回报进到派发人（pm_1）的会话，且不是"纯事实"
    const notice = await waitFor(async () => {
      const log = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_pm_1/log` })
      const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      return events.find((event) => event.kind === 'message' && String(event.payload['text'] ?? '').includes('已汇报任务')) ?? null
    }, '派发人会话出现汇报通知')
    const noticeText = String(notice.payload['text'])
    expect(noticeText).toContain('dev_1 已汇报任务')
    expect(noticeText).toContain('已实现并自测')
    expect(noticeText).toContain('请据此继续你的计划')

    // ② "接收到"之后真的继续执行：为下一步派了新单（剧本 ②）
    const followUp = await waitFor(async () => {
      const list = await context.app.inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?creator=pm_1` })
      return list.json<TaskRecord[]>().find((task) => task.title === '补充登录模块自测用例') ?? null
    }, '派发人继续派单')
    expect(followUp).toMatchObject({ assignee: 'dev_1', creator: 'pm_1', state: 'todo' })

    // ③ 派发人的上下文能看到"自己派出去的活"（跨回合仍成立，不靠翻聊天记录）
    const preview = await context.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agents/pm_1/system-prompt`,
    })
    const blocks = preview.json<{ blocks: Array<{ id: string; text: string }> }>().blocks
    const delegated = blocks.find((block) => block.id === 'delegated-tasks')
    expect(delegated?.text).toContain('t_')
    expect(delegated?.text).toContain('实现登录模块')
    expect(delegated?.text).toContain('done')
    expect(delegated?.text).toContain('请据此继续你自己的计划')
  })
})
