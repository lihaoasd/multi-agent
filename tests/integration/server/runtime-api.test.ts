import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import type { RuntimeSnapshot } from '../../../src/ports/runtime'
import { EMPTY_DISPATCHER_STATE } from '../../../src/ports/dispatcher'

/**
 * 规则 20：可停止与运行细条、项目导出。
 * ⚠️ S21/D27（2026-09-16）：未完成回合的判定与恢复已从平台移除（改由 Agent 自查 + `ask_user`），
 * 因此本文件不再有规则 19/14 的恢复用例，改为断言 `/recovery` 接口确实已下线。
 */
describe('API · 运行控制与导出（规则 20）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '运行控制演示', workdir: mkdtempSync(join(tmpdir(), 'ah-runtime-api-')) },
    })
    projectId = created.json<{ id: string }>().id
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('S21/D27：恢复接口已下线（项目级与会话级均 404）', async () => {
    const projectLevel = await inject({ method: 'GET', url: `/api/projects/${projectId}/recovery` })
    expect(projectLevel.statusCode).toBe(404)

    const sessionLevel = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/recovery` })
    expect(sessionLevel.statusCode).toBe(404)

    const resolve = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/recovery`,
      payload: { turn: 1, action: 'report' },
    })
    expect(resolve.statusCode).toBe(404)
  })

  it('规则 20：运行细条只列占用中的 Agent，并带回合/队列/任务；idle 单独计数；不再有未完成回合字段', async () => {
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
    expect(Object.keys(body.working[0] ?? {})).not.toContain('unfinishedTurn')
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
