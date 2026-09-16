import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestServer, type TestContext } from '../helpers-server'
import { configureTestModel } from '../helpers-model'
import { createScriptedGateway } from '../helpers-scripted-gateway'
import type { ArtifactRecord } from '../../src/ports/artifact'
import type { MemoryEntry } from '../../src/ports/memory'
import type { OrchestrationGraph } from '../../src/ports/orchestration'
import type { QuestionRecord } from '../../src/ports/question'
import type { TaskRecord } from '../../src/ports/task'
import type { ToolCallContext, ToolOutcome } from '../../src/ports/tools'
import type { RuntimeSnapshot } from '../../src/ports/runtime'

/**
 * prd §9 验收脚本 1~8（S9 全量验收；S10 起按"无假模型 + Agent 默认不配置模型"的新口径）。
 *
 * 与设计口径的一处说明：**产品面不再提供任何假模型供应商**（S10 移除 mock），
 * 因此协作步骤（委派/领取/汇报/提问/高危命令）通过两大通道验证：
 * ① 真实 agent loop + **脚本化网关替身**（`createScriptedGateway`，仅存在于 tests/）让模型真的发起 tool-call；
 * ② 直接调用与 loop 同一套工具处理函数（`toolRegistry.get(name).handler`），用于需要并发应答的步骤。
 * 模型配置一律**显式登记**（`configureTestModel`），脚本 2 专门覆盖"未配置模型"的引导路径。
 */

const PROJECT_NAME = 'prd §9 验收项目'

interface ApprovalBody {
  id: string
  kind: string
  status: string
  summary: string
}

describe('prd §9 验收脚本 1~8（S9 全量验收）', () => {
  let context: TestContext
  let projectId: string
  let workdir: string

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ah-accept-'))
    writeFileSync(join(workdir, 'important.txt'), '不要被删掉', 'utf8')
    const gateway = createScriptedGateway([
      // ① 用户在 PM 会话发消息（＝启动）：PM 沿出边委派给 dev
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('开始')),
        toolCalls: [
          { name: 'task_assign', args: { assignee: 'dev_1', title: '实现登录模块', desc: '按 PRD 实现并自测' } },
        ],
      },
      { text: '已按编排图把「实现登录模块」派给 dev_1（todo，待领取）。' },
      // ② 受派人被唤醒后的回合：先看自己的任务
      {
        when: (request) =>
          request.messages.some((message) => message.role === 'user' && message.content.startsWith('[任务]')),
        toolCalls: [{ name: 'task_list', args: { mine: true } }],
      },
      { text: '收到任务通知，准备领取。' },
      // ③ 领取后开工：写文件 + 记一条角色记忆
      {
        when: (request) =>
          request.messages.some((message) => message.role === 'user' && message.content.includes('开始实现')),
        toolCalls: [
          { name: 'workdir_edit', args: { path: 'workdir://src/login.ts', content: 'export const login = () => {}' } },
          { name: 'memory_append', args: { content: '登录模块按 PRD 实现，已自测通过', type: 'progress' } },
        ],
      },
      { text: '已完成登录模块初稿并记录进度。' },
    ])
    context = await createTestServer({ gateway })
    // S10：出厂无任何供应商/模型，验收显式登记一个平台默认模型（网关为替身，不联网）
    await configureTestModel(context.deps, { providerId: 'accept-provider', modelId: 'accept-model' })

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: PROJECT_NAME, workdir },
    })
    projectId = created.json<{ id: string }>().id

    // 内置模板默认 plan-execute（先产出计划再执行）；脚本化验收把相关实例覆盖为 direct，
    // 使"模型一次调用即发起工具调用"的剧本确定可复现（同时也验证实例级 loop 覆盖生效）。
    for (const instanceId of ['pm_1', 'dev_1', 'qa_1', 'ops_1']) {
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

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  const callTool = async (name: string, args: unknown, instanceId: string, turn = 1): Promise<ToolOutcome> => {
    const entry = context.deps.toolRegistry.get(name)
    if (entry === undefined) throw new Error(`工具未注册：${name}`)
    const toolContext: ToolCallContext = {
      projectId,
      instanceId,
      sessionId: `u_${instanceId}`,
      sessionType: 'user',
      turn,
      sourceSeq: turn,
      roots: { workdir, runtime: process.cwd(), readonly: [join(process.cwd(), 'src', 'shared')] },
      requestApproval: async () => ({ ok: true, value: { decision: 'approved' as const, approvalId: null } }),
      signal: new AbortController().signal,
    }
    return entry.handler(args, toolContext)
  }

  const waitFor = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 8000): Promise<T> => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('脚本 1：可跑通全流程（工具包/模板 → 建项目 → 画布连线 → 对话启动 → 沿出边委派 → 领取 → 提问答复 → 汇报 → 产出物与记忆 → 重开恢复）', async () => {
    // 1.1 首页可见：7 个基础工具包全部真实注册 + 8 个内置模板（含场景标签）
    const packages = await inject({ method: 'GET', url: '/api/tool-packages' })
    expect(packages.json<Array<{ id: string; tools: Array<{ registered: boolean }> }>>()).toHaveLength(7)
    const templates = await inject({ method: 'GET', url: '/api/agent-templates' })
    const templateList = templates.json<Array<{ roleId: string; scenario?: string; source: string }>>()
    expect(templateList.filter((item) => item.source === 'builtin')).toHaveLength(8)
    expect(templateList.every((item) => (item.scenario ?? 'software').length > 0)).toBe(true)

    // 1.2 创建项目：默认勾选 8 个内置模板
    const team = await inject({ method: 'GET', url: `/api/projects/${projectId}/team` })
    expect(team.json<unknown[]>()).toHaveLength(8)

    // 1.3 拓扑导航：画布连线并保存（pm → dev、dev → qa）
    const graph = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    const initial = graph.json<OrchestrationGraph>()
    expect(initial.nodes).toHaveLength(8)
    const saved = await inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/orchestration`,
      payload: {
        version: initial.version,
        nodes: initial.nodes,
        edges: [
          { from: 'pm_1', to: 'dev_1' },
          { from: 'dev_1', to: 'qa_1' },
        ],
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json<OrchestrationGraph>().version).toBe(1)

    // 1.4 对话导航：在 PM 会话发消息（＝启动）→ PM 沿出边委派（真实 loop + tool-call）
    const sent = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_pm_1/messages`,
      payload: { text: '开始：把登录模块交给开发' },
    })
    expect(sent.statusCode).toBe(202)
    const pmLog = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_pm_1/log` })
    const pmEvents = pmLog.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
    expect(pmEvents.some((event) => event.kind === 'tool_call' && event.payload['tool'] === 'task_assign')).toBe(true)

    const tasks = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks` })
    const task = tasks.json<TaskRecord[]>()[0]
    if (task === undefined) throw new Error('委派未产生任务')
    expect(task).toMatchObject({ creator: 'pm_1', assignee: 'dev_1', state: 'todo', title: '实现登录模块' })

    // 1.5 dev 被唤醒（通知消息触发一轮真实回合：脚本化网关调用 task_list）
    await waitFor(async () => {
      const log = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
      const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      return events.some((event) => event.kind === 'tool_call' && event.payload['tool'] === 'task_list') ? true : null
    }, 'dev 回合调用 task_list')

    // 1.6 dev 领取任务（工具与 loop 同源）后开工：发消息触发新一轮，脚本化网关写文件 + 记记忆
    const claim = await callTool('task_claim', { taskId: task.id }, 'dev_1')
    expect(claim.ok).toBe(true)
    const implement = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_dev_1/messages`,
      payload: { text: '开始实现登录模块' },
    })
    expect(implement.statusCode).toBe(202)
    await waitFor(async () => {
      const log = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
      const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      return events.some((event) => event.kind === 'tool_call' && event.payload['tool'] === 'workdir_edit') ? true : null
    }, 'dev 回合调用 workdir_edit')

    // 1.7 dev 需要决策时提问 → 我在右栏询问列表答复 → 回合继续
    const asked = await context.deps.questions.ask({
      projectId,
      sessionId: 'u_dev_1',
      asker: 'dev_1',
      title: '登录方案选哪个？',
      items: [{ text: '方案', options: ['JWT', 'Session'] }],
    })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return
    const pendingQuestions = await inject({ method: 'GET', url: `/api/projects/${projectId}/questions?status=pending` })
    expect(pendingQuestions.json<QuestionRecord[]>()).toHaveLength(1)
    const answered = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/questions/${asked.value.id}/answer`,
      payload: { answers: [{ itemId: 'i_1', choice: 'JWT' }] },
    })
    expect(answered.statusCode).toBe(200)

    // 1.8 dev 汇报完成 → 产出物与记忆可见
    const reported = await callTool('task_update', { taskId: task.id, state: 'done', note: '已实现并自测' }, 'dev_1')
    expect(reported.ok).toBe(true)
    const done = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?state=done` })
    expect(done.json<TaskRecord[]>()[0]).toMatchObject({ id: task.id, note: '已实现并自测' })
    const settled = done.json<TaskRecord[]>()[0]
    if (settled === undefined) throw new Error('缺少已完成任务')

    const artifacts = await inject({ method: 'GET', url: `/api/projects/${projectId}/artifacts` })
    const codeArtifacts = artifacts.json<ArtifactRecord[]>().filter((item) => item.type === 'code')
    expect(codeArtifacts.length).toBeGreaterThan(0)
    expect(codeArtifacts[0]?.files.map((file) => file.relPath)).toContain('src/login.ts')
    expect(settled.artifactIds.length).toBeGreaterThan(0)

    const memories = await inject({ method: 'GET', url: `/api/projects/${projectId}/memories` })
    expect(memories.json<{ entries: MemoryEntry[] }>().entries.map((entry) => entry.content)).toContain(
      '登录模块按 PRD 实现，已自测通过',
    )

    // 1.9 关闭浏览器/进程重开：新容器读同一数据根，会话与画布仍在
    const revived = await createTestServer({ root: context.root, cleanupRoot: false })
    try {
      const revivedSessions = await revived.app.inject({ method: 'GET', url: `/api/projects/${projectId}/sessions` })
      expect(revivedSessions.json<Array<{ sessionId: string; lastSeq: number }>>().length).toBe(8)
      const revivedGraph = await revived.app.inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
      expect(revivedGraph.json<OrchestrationGraph>()).toMatchObject({ version: 1 })
      expect(revivedGraph.json<OrchestrationGraph>().edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
        'pm_1->dev_1',
        'dev_1->qa_1',
      ])
      const revivedMemories = await revived.app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories` })
      expect(revivedMemories.json<{ count: number }>().count).toBeGreaterThan(0)
    } finally {
      await revived.cleanup()
    }
  })

  it('脚本 2：出厂无假模型，未配置模型的 Agent 启动即明确引导（ERR_MODEL，不静默降级）', async () => {
    const fresh = await createTestServer()
    try {
      // 2.1 预置目录只有真实供应商；出厂配置为空
      const presets = await fresh.app.inject({ method: 'GET', url: '/api/model-presets' })
      const kinds = presets.json<Array<{ presetId: string; kind: string }>>()
      expect(kinds.map((item) => item.kind)).toEqual(
        expect.arrayContaining(['openai-compatible', 'anthropic', 'gemini', 'ollama']),
      )
      expect(kinds.map((item) => item.kind)).not.toContain('mock')
      expect(kinds.map((item) => item.presetId)).not.toContain('mock')

      const providers = await fresh.app.inject({ method: 'GET', url: '/api/model-providers' })
      expect(providers.json<unknown[]>()).toEqual([])
      const models = await fresh.app.inject({ method: 'GET', url: '/api/models' })
      expect(models.json<unknown[]>()).toEqual([])
      const routing = await fresh.app.inject({ method: 'GET', url: '/api/model-routing' })
      expect(routing.json<{ defaultModelId: string | null }>().defaultModelId).toBeNull()

      // 2.2 未注册任何 kind=mock 供应商（协议适配器已删除）
      const rejected = await fresh.app.inject({
        method: 'POST',
        url: '/api/model-providers',
        payload: { id: 'legacy-mock', name: 'legacy', kind: 'mock', baseUrl: '' },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json<{ code: string }>().code).toBe('ERR_VALIDATION')

      // 2.3 新建项目的 Agent 生效模型为空（默认未配置）
      const created = await fresh.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '未配置模型验收', workdir },
      })
      const freshProject = created.json<{ id: string }>().id
      const instance = await fresh.app.inject({ method: 'GET', url: `/api/projects/${freshProject}/team/dev_1` })
      expect(instance.json<{ effective: { model: string | null }; effectiveModelAvailable: boolean }>()).toMatchObject({
        effective: { model: null },
        effectiveModelAvailable: false,
      })

      // 2.4 启动回合 → 明确引导（ERR_MODEL + 配置指引），且不会静默换模型
      const sent = await fresh.app.inject({
        method: 'POST',
        url: `/api/projects/${freshProject}/sessions/u_dev_1/messages`,
        payload: { text: '开始' },
      })
      expect(sent.statusCode).toBe(202)

      const events = await waitFor(async () => {
        const log = await fresh.app.inject({
          method: 'GET',
          url: `/api/projects/${freshProject}/sessions/u_dev_1/log`,
        })
        const list = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
        return list.some((event) => event.kind === 'error') ? list : null
      }, '未配置模型的回合给出错误')
      const error = events.find((event) => event.kind === 'error')
      expect(error?.payload['errorCode']).toBe('ERR_MODEL')
      expect(String(error?.payload['message'])).toContain('模型')
    } finally {
      await fresh.cleanup()
    }
  })

  it('脚本 3：单工与状态正确（忙/暂停时入队，恢复后补处理；状态与占用一致）', async () => {
    const paused = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/qa_1/pause` })
    expect(paused.statusCode).toBe(200)
    const queued = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions/u_qa_1/messages`,
      payload: { text: '回归测试支付流程' },
    })
    expect(queued.json<{ queued: boolean }>().queued).toBe(true)

    const statuses = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    const qa = statuses.json<Array<{ instanceId: string; state: string; paused: boolean; queued: number }>>().find(
      (item) => item.instanceId === 'qa_1',
    )
    expect(qa).toMatchObject({ state: 'idle', paused: true })
    expect(qa?.queued).toBeGreaterThan(0)

    const runtime = await inject({ method: 'GET', url: `/api/projects/${projectId}/runtime` })
    expect(runtime.json<RuntimeSnapshot>().paused).toBe(1)

    const resumed = await inject({ method: 'POST', url: `/api/projects/${projectId}/agents/qa_1/resume` })
    expect(resumed.json<{ handled: number }>().handled).toBe(1)
    const after = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    const qaAfter = after
      .json<Array<{ instanceId: string; state: string; paused: boolean; queued: number }>>()
      .find((item) => item.instanceId === 'qa_1')
    expect(qaAfter).toMatchObject({ state: 'idle', paused: false, queued: 0 })
  })

  it('脚本 4：安全（高危命令未批准不执行、越界路径拒绝、他人产出物不可改）', async () => {
    // 4.1 高危命令：真实 loop 发起 → 策略要求审批 → 我拒绝 → 命令未执行
    const gateway = createScriptedGateway([
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('清理')),
        toolCalls: [{ name: 'cmd_run', args: { program: 'rm', args: ['-rf', 'important.txt'] } }],
      },
      { text: '命令被拒绝，我改用其他方式。' },
    ])
    const danger = await createTestServer({ gateway, envMap: {}, root: `${context.root}-danger` })
    try {
      await configureTestModel(danger.deps, { providerId: 'danger-provider', modelId: 'danger-model' })
      const created = await danger.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '安全验收', workdir },
      })
      const dangerProject = created.json<{ id: string }>().id
      await danger.app.inject({
        method: 'PATCH',
        url: `/api/projects/${dangerProject}/team/dev_1`,
        payload: { loop: { strategy: 'direct', params: {} } },
      })
      const sending = danger.app.inject({
        method: 'POST',
        url: `/api/projects/${dangerProject}/sessions/u_dev_1/messages`,
        payload: { text: '请清理一下工作目录' },
      })

      const approval = await waitFor(async () => {
        const listed = await danger.app.inject({
          method: 'GET',
          url: `/api/projects/${dangerProject}/approvals?status=pending`,
        })
        const list = listed.json<ApprovalBody[]>()
        return list[0] ?? null
      }, '高危命令进入待审批')
      expect(approval.summary).toContain('rm')

      await danger.app.inject({
        method: 'POST',
        url: `/api/projects/${dangerProject}/approvals/${approval.id}/decide`,
        payload: { decision: 'rejected', reason: '不允许删除' },
      })
      await sending

      // 命令确实没执行：文件还在
      expect(readFileSync(join(workdir, 'important.txt'), 'utf8')).toBe('不要被删掉')
      // 拒绝结果回注 Agent（回合内出现审批结果事件）
      const log = await danger.app.inject({ method: 'GET', url: `/api/projects/${dangerProject}/sessions/u_dev_1/log` })
      expect(
        log
          .json<Array<{ kind: string; payload: Record<string, unknown> }>>()
          .some((event) => event.kind === 'approval_result' && event.payload['decision'] === 'rejected'),
      ).toBe(true)
    } finally {
      await danger.cleanup()
    }

    // 4.2 越界读写：一律拒绝（含 .. 与绝对路径）
    const escape = await callTool('fs_read_file', { path: 'workdir://../secret.txt' }, 'dev_1')
    expect(escape.ok).toBe(false)
    expect(escape.errorCode).toBe('ERR_FORBIDDEN_PATH')
    const absolute = await callTool('workdir_edit', { path: 'workdir://C:/windows/x.txt', content: 'x' }, 'dev_1')
    expect(absolute.ok).toBe(false)

    // 4.3 他人产出物不可修改（ERR_FORBIDDEN 并点名）
    const stolen = await callTool('workdir_edit', { path: 'workdir://src/login.ts', content: '篡改' }, 'qa_1')
    expect(stolen.ok).toBe(false)
    expect(stolen.errorCode).toBe('ERR_FORBIDDEN')
    expect(stolen.text).toContain('高级开发')
  })

  it('脚本 5：文档交付（全套文档存在、阶段方案与记录齐备、README 索引同步）', () => {
    const docs = ['requirements/prd.md', 'design/architecture.md', 'design/abstraction.md', 'api/contract.md', 'plan/development.md', 'testing/plan.md']
    for (const doc of docs) expect(existsSync(join(process.cwd(), 'docs', doc)), doc).toBe(true)

    const plans = readdirSync(join(process.cwd(), 'docs', 'plan'))
    const changes = readdirSync(join(process.cwd(), 'docs', 'changes'))
    for (const stage of ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11']) {
      expect(plans.some((file) => file.includes(`-${stage}-`)), `plan ${stage}`).toBe(true)
      expect(changes.some((file) => file.includes(`-${stage}-`)), `changes ${stage}`).toBe(true)
    }

    const readme = readFileSync(join(process.cwd(), 'docs', 'README.md'), 'utf8')
    expect(readme).toContain('plan/development.md')
    expect(readme).toContain('testing/plan.md')
  })

  it('脚本 6：编排约束生效（越边委派被拒且不建任务；用户手动派单不受限）', async () => {
    const graphBefore = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    const versionBefore = graphBefore.json<OrchestrationGraph>().version
    const edgesBefore = graphBefore.json<OrchestrationGraph>().edges.length

    const denied = await callTool('task_assign', { assignee: 'ux_1', title: '越边派单' }, 'dev_1')
    expect(denied.ok).toBe(false)
    expect(denied.errorCode).toBe('ERR_ORCHESTRATION_EDGE')

    const uxTasks = await inject({ method: 'GET', url: `/api/projects/${projectId}/tasks?assignee=ux_1` })
    expect(uxTasks.json<TaskRecord[]>()).toEqual([])

    const graphAfter = await inject({ method: 'GET', url: `/api/projects/${projectId}/orchestration` })
    expect(graphAfter.json<OrchestrationGraph>()).toMatchObject({ version: versionBefore })
    expect(graphAfter.json<OrchestrationGraph>().edges).toHaveLength(edgesBefore)

    const byUser = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      payload: { assignee: 'ux_1', title: '用户手动派单' },
    })
    expect(byUser.statusCode).toBe(201)
  })

  it('脚本 7：控制与询问可用（暂停挂起、停止终止并结算快照、询问阻塞后继续）', async () => {
    // 7.1 停止任务：先结算未结算改动为 snapshot
    const created = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      payload: { assignee: 'ops_1', title: '部署脚本' },
    })
    const taskId = created.json<{ task: TaskRecord }>().task.id
    await inject({ method: 'PATCH', url: `/api/projects/${projectId}/tasks/${taskId}`, payload: { state: 'in_progress' } })
    await context.deps.artifacts.editFile({
      projectId,
      instanceId: 'ops_1',
      relPath: 'deploy/run.sh',
      content: 'echo deploy',
      taskId,
      sessionId: 'u_ops_1',
      turn: 1,
    })
    const stopped = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/ops_1/stop`,
      payload: { scope: 'task' },
    })
    expect(stopped.json<{ taskId: string; settledArtifactId: string }>()).toMatchObject({ taskId })
    expect(stopped.json<{ settledArtifactId: string }>().settledArtifactId).toBeTruthy()
    const settled = await inject({ method: 'GET', url: `/api/projects/${projectId}/artifacts?taskId=${taskId}` })
    expect(settled.json<ArtifactRecord[]>()[0]).toMatchObject({ type: 'code', taskId, state: 'approved' })

    // 7.2 询问阻塞：真实 loop 调用 ask_user，右栏答复后该回合继续
    const gateway = createScriptedGateway([
      {
        when: (request) => request.messages.some((message) => message.role === 'user' && message.content.includes('要不要')),
        toolCalls: [{ name: 'ask_user', args: { title: '是否继续重构？', items: [{ text: '继续？', options: ['继续', '停止'] }] } }],
      },
      { text: '收到答复，继续推进。' },
    ])
    const asking = await createTestServer({ gateway, root: `${context.root}-asking` })
    try {
      await configureTestModel(asking.deps, { providerId: 'asking-provider', modelId: 'asking-model' })
      const createdProject = await asking.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '询问验收', workdir },
      })
      const askingProject = createdProject.json<{ id: string }>().id
      await asking.app.inject({
        method: 'PATCH',
        url: `/api/projects/${askingProject}/team/dev_1`,
        payload: { loop: { strategy: 'direct', params: {} } },
      })
      const sending = asking.app.inject({
        method: 'POST',
        url: `/api/projects/${askingProject}/sessions/u_dev_1/messages`,
        payload: { text: '要不要继续重构？' },
      })

      const question = await waitFor(async () => {
        const listed = await asking.app.inject({
          method: 'GET',
          url: `/api/projects/${askingProject}/questions?status=pending`,
        })
        return listed.json<QuestionRecord[]>()[0] ?? null
      }, 'ask_user 进入待答')
      expect(question.title).toBe('是否继续重构？')

      // 该 Agent 处于 waiting（占用 + 待答询问）
      const statuses = await asking.app.inject({ method: 'GET', url: `/api/projects/${askingProject}/agents` })
      expect(
        statuses.json<Array<{ instanceId: string; state: string }>>().find((item) => item.instanceId === 'dev_1')?.state,
      ).toBe('waiting')

      await asking.app.inject({
        method: 'POST',
        url: `/api/projects/${askingProject}/questions/${question.id}/answer`,
        payload: { answers: [{ itemId: 'i_1', choice: '继续' }] },
      })
      await sending
      const log = await asking.app.inject({ method: 'GET', url: `/api/projects/${askingProject}/sessions/u_dev_1/log` })
      const events = log.json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      expect(events.some((event) => event.kind === 'tool_call' && event.payload['tool'] === 'ask_user')).toBe(true)
      expect(events.some((event) => event.kind === 'turn_end')).toBe(true)
    } finally {
      await asking.cleanup()
    }
  })

  it('脚本 8：模型配置与 Agent 配置可用（预置/测试连接/默认模型/复制模板/实例覆盖/引用保护/密钥掩码）', async () => {
    // 8.1 预置供应商目录 9 家（无假模型）并可新建 + 测试连接（Ollama 走 `/api/tags`，用替身 fetch 保持离线可跑）
    const presets = await inject({ method: 'GET', url: '/api/model-presets' })
    expect(presets.json<unknown[]>().length).toBeGreaterThanOrEqual(9)
    const added = await inject({ method: 'POST', url: '/api/model-providers', payload: { presetId: 'ollama' } })
    expect(added.statusCode).toBeLessThan(300)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const tested = await inject({ method: 'POST', url: '/api/model-providers/ollama/test', payload: { mode: 'models' } })
    expect(tested.statusCode).toBe(200)

    // 8.2 登记模型条目 + 设全局默认（无需重启即生效）
    const model = await inject({
      method: 'POST',
      url: '/api/models',
      payload: { id: 'accept-extra', providerId: 'ollama', model: 'qwen3:8b', displayName: 'Qwen3 8B' },
    })
    expect(model.statusCode).toBeLessThan(300)
    const modelId = model.json<{ id: string }>().id
    const routing = await inject({ method: 'PUT', url: '/api/model-routing', payload: { defaultModelId: modelId } })
    expect(routing.statusCode).toBe(200)

    // 8.3 基于内置复制新建模板并改提示词 / loop / 模型
    const copied = await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId: 'dev-copy', copyFrom: 'dev', name: '高级开发（复制）' },
    })
    expect(copied.statusCode).toBeLessThan(300)
    const patched = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/dev-copy',
      payload: { systemPrompt: '你是复制出来的开发', defaultLoop: { strategy: 'plan-execute', params: { maxIterations: 3 } }, defaultModel: modelId },
    })
    expect(patched.statusCode).toBe(200)
    const builtin = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/dev',
      payload: { systemPrompt: '改内置模板' },
    })
    expect(builtin.statusCode).toBe(403)

    // 8.4 项目内实例覆盖三项，且生效（下一回合）
    const instance = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/pm_1`,
      payload: { prompt: '你是本项目的 PM（覆盖）', model: modelId, loop: { strategy: 'reflective', params: { maxIterations: 2 } } },
    })
    expect(instance.statusCode).toBe(200)
    const effective = await inject({ method: 'GET', url: `/api/projects/${projectId}/team/pm_1/effective-config` })
    expect(effective.json<{ model: string | null; loop: { strategy: string } }>()).toMatchObject({
      model: modelId,
      loop: { strategy: 'reflective' },
    })

    // 8.5 引用保护：删除被引用的模型条目/供应商被拒并点名引用者
    const blockedModel = await inject({ method: 'DELETE', url: `/api/models/${modelId}` })
    expect(blockedModel.statusCode).toBe(409)
    expect(blockedModel.json<{ code: string; detail?: { referrers?: unknown[] } }>().code).toBe('ERR_CONFLICT')
    expect(blockedModel.json<{ detail?: { referrers?: unknown[] } }>().detail?.referrers?.length).toBeGreaterThan(0)

    // 8.6 密钥只以掩码出现（响应里不得出现明文）
    const providers = await inject({ method: 'GET', url: '/api/model-providers' })
    const text = providers.body
    expect(text).not.toContain('sk-live')
    expect(providers.json<Array<{ credential: { masked?: string | null } }>>()[0]?.credential).toBeDefined()
    const config = await inject({ method: 'GET', url: '/api/config' })
    expect(config.statusCode).toBe(200)
  })
})
