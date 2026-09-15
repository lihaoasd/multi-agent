import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import type { RuntimeSnapshot, UnfinishedTurn } from '../../../src/ports/runtime'
import { EMPTY_DISPATCHER_STATE } from '../../../src/ports/dispatcher'

/** 规则 14/19/20：未完成回合三选、可停止与运行细条、项目导出 */
describe('API · 运行控制与恢复（规则 14/19/20）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '恢复与停止演示', workdir: mkdtempSync(join(tmpdir(), 'ah-runtime-api-')) },
    })
    projectId = created.json<{ id: string }>().id
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('规则 19：缺 turn_end → 横幅数据；三选 report 落标记 + 注入唤醒消息；重复处理 409', async () => {
    await context.deps.sessions.append(projectId, 'u_dev_1', [
      { kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1', loopStep: 'plan-execute' } },
      { kind: 'plan', turn: 1, payload: { steps: [{ id: 's1' }, { id: 's2' }], status: 'interrupted' } },
    ])

    const listed = await inject({ method: 'GET', url: `/api/projects/${projectId}/recovery` })
    expect(listed.statusCode).toBe(200)
    const unfinished = listed.json<UnfinishedTurn[]>()
    expect(unfinished).toHaveLength(1)
    expect(unfinished[0]).toMatchObject({ sessionId: 'u_dev_1', turn: 1, loopStep: 'plan-execute', resolvedBy: null })
    expect(unfinished[0]?.lastPlan).toEqual({ steps: 2, status: 'interrupted' })

    const session = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/recovery` })
    expect(session.json<UnfinishedTurn>().turn).toBe(1)

    const resolved = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/recovery`,
      payload: { turn: 1, action: 'report' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json<{ resumed: boolean; text: string }>().resumed).toBe(true)
    expect(resolved.json<{ text: string }>().text).toContain('汇报')

    // 标记落盘（state 事件）+ 唤醒消息（系统消息）
    const log = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
    const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
    expect(events.some((event) => event.kind === 'state' && event.payload['recovery'] === 'report')).toBe(true)
    expect(events.some((event) => event.kind === 'message' && event.payload['sender'] === 'system')).toBe(true)

    // 横幅数据保留 resolvedBy（不再重复提示）
    const afterReport = await inject({ method: 'GET', url: `/api/projects/${projectId}/recovery` })
    expect(afterReport.json<UnfinishedTurn[]>()[0]?.resolvedBy).toBe('report')

    const again = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/recovery`,
      payload: { turn: 1, action: 'ignore' },
    })
    expect(again.statusCode).toBe(409)

    const badAction = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/recovery`,
      payload: { turn: 1, action: 'unknown' },
    })
    expect(badAction.statusCode).toBe(400)
  })

  it('规则 14：忽略不唤醒；完整回合不会被判定为未完成', async () => {
    await context.deps.sessions.append(projectId, 'u_qa_1', [
      { kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1' } },
      { kind: 'turn_end', turn: 1, payload: { ok: true } },
    ])
    const none = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_qa_1/recovery` })
    expect(none.json<UnfinishedTurn | null>()).toBeNull()

    await context.deps.sessions.append(projectId, 'u_qa_1', [{ kind: 'turn_start', turn: 2, payload: { turnId: 'turn_2' } }])
    const ignored = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_qa_1/recovery`,
      payload: { turn: 2, action: 'ignore' },
    })
    expect(ignored.json<{ resumed: boolean }>().resumed).toBe(false)
    const log = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_qa_1/log` })
    expect(
      log
        .json<Array<{ kind: string; payload: Record<string, unknown> }>>()
        .some((event) => event.kind === 'state' && event.payload['recovery'] === 'ignore'),
    ).toBe(true)
  })

  it('规则 20：运行细条只列占用中的 Agent，并带回合/队列/任务；idle 单独计数', async () => {
    // 直接写调度态（occupancy 是运行期占用的唯一真相）
    const saved = await context.deps.fileStore.writeJsonAtomic(
      `${context.dataDir}/projects/${projectId}/runtime.state.json`,
      {
        ...EMPTY_DISPATCHER_STATE,
        occupancy: { dev_1: { type: 'user', sessionId: 'u_dev_1', since: '2026-09-15T00:00:00.000Z' } },
        turns: { dev_1: 1 },
      },
    )
    expect(saved.ok).toBe(true)

    const snapshot = await inject({ method: 'GET', url: `/api/projects/${projectId}/runtime` })
    expect(snapshot.statusCode).toBe(200)
    const body = snapshot.json<RuntimeSnapshot>()
    expect(body.working.map((item) => item.instanceId)).toEqual(['dev_1'])
    expect(body.working[0]).toMatchObject({ state: 'working', turn: 1, startedAt: '2026-09-15T00:00:00.000Z' })
    expect(body.idle).toBeGreaterThan(0)
  })

  it('规则 20：停止当前回合（scope=turn）与终止当前任务（scope=task，先结算）', async () => {
    const turn = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/dev_1/stop`,
      payload: { scope: 'turn' },
    })
    expect(turn.statusCode).toBe(200)
    expect(turn.json<{ aborted: boolean; taskId: string | null }>()).toMatchObject({ taskId: null })

    // 造一条进行中任务 + 未结算改动，再按 task 停止
    const created = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      payload: { assignee: 'dev_1', title: '改造支付流程' },
    })
    const taskId = created.json<{ task: { id: string } }>().task.id
    await inject({ method: 'PATCH', url: `/api/projects/${projectId}/tasks/${taskId}`, payload: { state: 'in_progress' } })
    await context.deps.artifacts.editFile({
      projectId,
      instanceId: 'dev_1',
      relPath: 'src/pay.ts',
      content: 'export const pay = 1',
      taskId,
      sessionId: 'u_dev_1',
      turn: 1,
    })

    const stopped = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/dev_1/stop`,
      payload: { scope: 'task' },
    })
    expect(stopped.statusCode).toBe(200)
    const body = stopped.json<{ taskId: string; settledArtifactId: string }>()
    expect(body.taskId).toBe(taskId)
    expect(body.settledArtifactId).toBeTruthy()

    const task = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?state=terminated` })
    expect(task.json<Array<{ id: string }>>().map((item) => item.id)).toContain(taskId)

    const badScope = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/dev_1/stop`,
      payload: { scope: 'nope' },
    })
    expect(badScope.statusCode).toBe(400)
  })

  it('项目导出：application/zip + 附件名，内容含会话日志与说明', async () => {
    const exported = await inject({ method: 'GET', url: `/api/projects/${projectId}/export` })
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-type']).toContain('application/zip')
    expect(String(exported.headers['content-disposition'])).toContain(`${projectId}.zip`)
    const raw = exported.rawPayload
    expect(raw.subarray(0, 4).toString('hex')).toBe('504b0304')
    const text = raw.toString('utf8')
    expect(text).toContain('EXPORT-README.txt')
    expect(text).toContain('sessions/u_dev_1.log.jsonl')
  })

  it('导出不存在的项目 → 404', async () => {
    const missing = await inject({ method: 'GET', url: '/api/projects/p_missing/export' })
    expect(missing.statusCode).toBe(404)
  })
})
