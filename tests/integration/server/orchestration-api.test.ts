import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import type { OrchestrationGraph } from '../../../src/ports/orchestration'
import type { TaskRecord } from '../../../src/ports/task'
import type { ToolCallContext, ToolOutcome } from '../../../src/ports/tools'

/** 规则 22/23：编排图保存与校验 + 委派边约束（端到端） */
describe('API · 编排图与委派边（规则 22/23）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '编排演示', workdir: mkdtempSync(join(tmpdir(), 'ah-orch-api-')) },
    })
    projectId = created.json<{ id: string }>().id
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  const callTool = async (name: string, args: unknown, instanceId: string): Promise<ToolOutcome> => {
    const entry = context.deps.toolRegistry.get(name)
    if (entry === undefined) throw new Error(`工具未注册：${name}`)
    const toolContext: ToolCallContext = {
      projectId,
      instanceId,
      sessionId: `u_${instanceId}`,
      sessionType: 'user',
      turn: 1,
      sourceSeq: 1,
      roots: { workdir: process.cwd(), runtime: process.cwd(), readonly: [] },
      requestApproval: async () => ({ ok: true, value: { decision: 'approved' as const, approvalId: null } }),
      signal: new AbortController().signal,
    }
    return entry.handler(args, toolContext)
  }

  it('规则 22：GET 按团队归一化补齐节点，PUT 全量保存并广播', async () => {
    const initial = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    expect(initial.statusCode).toBe(200)
    const graph = initial.json<OrchestrationGraph>()
    expect(graph.version).toBe(0)
    expect(graph.nodes.map((node) => node.instanceId).sort()).toEqual([
      'architect_1',
      'dev_1',
      'ops_1',
      'pm_1',
      'product_1',
      'qa_1',
      'ui_1',
      'ux_1',
    ])

    const saved = await inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: {
        version: 0,
        nodes: graph.nodes.map((node, index) => ({ ...node, y: index * 10 })),
        edges: [
          { from: 'pm_1', to: 'dev_1' },
          { from: 'dev_1', to: 'qa_1' },
        ],
      },
    })
    expect(saved.statusCode).toBe(200)
    const next = saved.json<OrchestrationGraph>()
    expect(next.version).toBe(1)
    expect(next.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['pm_1->dev_1', 'dev_1->qa_1'])
    expect(context.broadcaster.events().some((event) => event.type === 'orchestration.updated')).toBe(true)

    // 版本冲突：拿旧 version 再存 → 409 ERR_CONFLICT
    const conflicted = await inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: { version: 0, nodes: next.nodes, edges: [] },
    })
    expect(conflicted.statusCode).toBe(409)
    expect(conflicted.json<{ code: string }>().code).toBe('ERR_CONFLICT')

    // 读回来仍是 v1（冲突不改盘）
    const reloaded = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    expect(reloaded.json<OrchestrationGraph>().version).toBe(1)
  })

  it('规则 22：自环 / 重复边 / 跨项目节点 → 400 ERR_ORCHESTRATION_INVALID；缺 version → 400', async () => {
    const current = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    const graph = current.json<OrchestrationGraph>()

    const cases: { payload: Record<string, unknown>; label: string }[] = [
      { payload: { version: graph.version, nodes: graph.nodes, edges: [{ from: 'dev_1', to: 'dev_1' }] }, label: '自环' },
      {
        payload: {
          version: graph.version,
          nodes: graph.nodes,
          edges: [
            { from: 'pm_1', to: 'dev_1' },
            { from: 'pm_1', to: 'dev_1' },
          ],
        },
        label: '重复边',
      },
      {
        payload: {
          version: graph.version,
          nodes: [...graph.nodes, { instanceId: 'ops_9', x: 0, y: 0, collapsed: false }],
          edges: [],
        },
        label: '跨项目节点',
      },
    ]
    for (const item of cases) {
      const response = await inject({ method: 'PUT', url: `/api/projects/${projectId}/orchestration`, payload: item.payload })
      expect(response.statusCode, item.label).toBe(400)
      expect(response.json<{ code: string }>().code, item.label).toBe('ERR_ORCHESTRATION_INVALID')
    }

    const missingVersion = await inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: { nodes: graph.nodes, edges: [] },
    })
    expect(missingVersion.statusCode).toBe(400)
  })

  it('规则 23：Agent 沿出边派单成功；越边 ERR_ORCHESTRATION_EDGE 且不建任务', async () => {
    const allowed = await callTool(
      'task_assign',
      { assignee: 'dev_1', title: '实现登录模块', desc: '按 PRD' },
      'pm_1',
    )
    expect(allowed.ok).toBe(true)
    expect(allowed.text).toContain('已派单')

    const denied = await callTool('task_assign', { assignee: 'qa_1', title: '越边派单' }, 'pm_1')
    expect(denied.ok).toBe(false)
    expect(denied.errorCode).toBe('ERR_ORCHESTRATION_EDGE')
    expect(denied.text).toContain('委派边')

    const qaTasks = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?assignee=qa_1` })
    expect(qaTasks.json<TaskRecord[]>()).toEqual([])

    const devTasks = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?assignee=dev_1` })
    expect(devTasks.json<TaskRecord[]>()).toHaveLength(1)
  })

  it('规则 23：用户手动派单不受边约束', async () => {
    const created = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      payload: { assignee: 'qa_1', title: '用户直接派单' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json<{ task: TaskRecord }>().task.assignee).toBe('qa_1')
  })
})
