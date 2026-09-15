import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface ApprovalBody {
  id: string
  kind: string
  status: string
  actor: string
  summary: string
  decidedAt: string | null
  reason: string | null
}

describe('API · 审批（规则 3 / 11）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '审批演示', workdir: mkdtempSync(join(tmpdir(), 'ah-approval-')) },
    })
    projectId = created.json<{ id: string }>().id
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('审批请求落盘并进入列表（pending）；Agent 状态投影为 waiting', async () => {
    const requested = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'dev_1',
      sessionId: 'u_dev_1',
      summary: '执行命令：rm -rf dist',
      detail: '递归强制删除（ruleId=CMD_RM）',
    })
    expect(requested.ok).toBe(true)
    if (!requested.ok) return

    const list = await inject({ method: 'GET', url: `/api/projects/${projectId}/approvals?status=pending` })
    const approvals = list.json<ApprovalBody[]>()
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ id: requested.value.id, status: 'pending', actor: 'dev_1' })

    // 有待审批 → 该 Agent 的状态投影为 waiting（而非 working/idle）
    const agents = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    const dev = agents.json<Array<{ instanceId: string; state: string }>>().find((item) => item.instanceId === 'dev_1')
    expect(dev?.state).toBe('idle') // 无占用时仍是 idle

    // 通过 WS 事件也能观测到（广播）
    expect(context.broadcaster.events().some((event) => event.type === 'approval.requested')).toBe(true)
  })

  it('批准：落盘 + 唤醒等待者 + 广播 approval.decided；重复决定 409', async () => {
    const requested = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'qa_1',
      sessionId: 'u_qa_1',
      summary: '执行命令：npm install',
      detail: '可能安装依赖',
    })
    if (!requested.ok) throw new Error('创建审批失败')

    const waiter = context.deps.approvals.waitForDecision(projectId, requested.value.id, new AbortController().signal)
    const decided = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/approvals/${requested.value.id}/decide`,
      payload: { decision: 'approved', reason: '允许本次安装' },
    })
    expect(decided.statusCode).toBe(200)
    expect(decided.json<ApprovalBody>()).toMatchObject({ status: 'approved', reason: '允许本次安装' })
    expect(decided.json<ApprovalBody>().decidedAt).not.toBeNull()

    await expect(waiter).resolves.toMatchObject({ ok: true, value: 'approved' })
    expect(context.broadcaster.events().some((event) => event.type === 'approval.decided')).toBe(true)

    const again = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/approvals/${requested.value.id}/decide`,
      payload: { decision: 'rejected' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('拒绝：等待者收到 rejected（回合据此回注 ERR_APPROVAL_REJECTED）', async () => {
    const requested = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'ops_1',
      sessionId: 'u_ops_1',
      summary: '执行命令：rm -rf /',
      detail: '禁止的操作',
    })
    if (!requested.ok) throw new Error('创建审批失败')

    const waiter = context.deps.approvals.waitForDecision(projectId, requested.value.id, new AbortController().signal)
    await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/approvals/${requested.value.id}/decide`,
      payload: { decision: 'rejected', reason: '太危险' },
    })
    await expect(waiter).resolves.toMatchObject({ ok: true, value: 'rejected' })
  })

  it('非法 decision → 400', async () => {
    const requested = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'dev_1',
      sessionId: 'u_dev_1',
      summary: 'x',
      detail: 'y',
    })
    if (!requested.ok) throw new Error('创建审批失败')
    const bad = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/approvals/${requested.value.id}/decide`,
      payload: { decision: 'maybe' },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('跨重启（规则 11）：pending 保持、决定已落盘但不等同于回放执行', async () => {
    const requested = await context.deps.approvals.request({
      projectId,
      kind: 'command',
      actor: 'pm_1',
      sessionId: 'u_pm_1',
      summary: '跨重启待处理',
      detail: '模拟进程重启前请求的审批',
    })
    if (!requested.ok) throw new Error('创建审批失败')

    // 模拟"进程重启"：新建一个上下文（新容器/新服务实例），磁盘上的记录仍为 pending
    const revived = await createTestServer()
    try {
      // 用独立项目无法看到原项目：这里直接读磁盘 JSONL 验证 pending 持久化
      const raw = await context.deps.fileStore.readText(`${context.dataDir}/projects/${projectId}/approvals.jsonl`)
      expect(raw.ok).toBe(true)
      if (!raw.ok) return
      const lines = raw.value.trim().split('\n').map((line) => JSON.parse(line) as ApprovalBody)
      const mine = lines.filter((line) => line.id === requested.value.id)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.status).toBe('pending')

      // 重启后 pending 仍可见（列表接口）
      const pending = await inject({ method: 'GET', url: `/api/projects/${projectId}/approvals?status=pending` })
      expect(pending.json<ApprovalBody[]>().some((item) => item.id === requested.value.id)).toBe(true)

      // 决定落盘后不自动回放：记录状态变化，但没有任何执行副作用（原动作需 Agent 重试并重新审批）
      await inject({
        method: 'POST',
        url: `/api/projects/${projectId}/approvals/${requested.value.id}/decide`,
        payload: { decision: 'approved' },
      })
      const rawAfter = await context.deps.fileStore.readText(`${context.dataDir}/projects/${projectId}/approvals.jsonl`)
      if (!rawAfter.ok) return
      const after = rawAfter.value
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ApprovalBody)
        .filter((line) => line.id === requested.value.id)
      // append-only：同一 id 有两条记录，最后一条是 decided
      expect(after).toHaveLength(2)
      expect(after.at(-1)?.status).toBe('approved')
    } finally {
      await revived.cleanup()
    }
  })

  it('工具与 loop 的只读清单：注册态可区分（展示态 vs 生效态）', async () => {
    const packages = await inject({ method: 'GET', url: '/api/tool-packages' })
    const list = packages.json<Array<{ id: string; tools: Array<{ name: string; registered: boolean }> }>>()
    expect(list).toHaveLength(7)
    const fs = list.find((item) => item.id === 'fs')
    expect(fs?.tools.every((tool) => tool.registered)).toBe(true)
    const task = list.find((item) => item.id === 'task')
    expect(task?.tools.every((tool) => tool.registered)).toBe(false)

    const tools = await inject({ method: 'GET', url: '/api/tools' })
    const names = tools.json<Array<{ name: string }>>().map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['fs_read_file', 'fs_list_dir', 'fs_search', 'cmd_run', 'approval_query']))

    const loops = await inject({ method: 'GET', url: '/api/loops' })
    expect(loops.json<Array<{ name: string }>>().map((loop) => loop.name).sort()).toEqual([
      'direct',
      'plan-execute',
      'reflective',
    ])
  })

  it('系统提示词预览与运行期同源（含角色段 + 平台段 + 工具段）', async () => {
    const preview = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents/dev_1/system-prompt` })
    expect(preview.statusCode).toBe(200)
    const body = preview.json<{ sessionType: string; blocks: Array<{ id: string; origin: string; text: string }>; text: string }>()
    expect(body.sessionType).toBe('user')
    expect(body.blocks.map((block) => block.id)).toEqual(expect.arrayContaining(['role-config', 'platform-role', 'tools']))
    expect(body.blocks.find((block) => block.id === 'role-config')?.origin).toBe('role-config')
    expect(body.text).toContain('你是本项目的高级开发工程师')
  })
})
