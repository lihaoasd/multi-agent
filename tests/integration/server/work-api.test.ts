import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import type { ArtifactRecord, FileOwnerRecord } from '../../../src/ports/artifact'
import type { TaskRecord } from '../../../src/ports/task'
import type { QuestionRecord } from '../../../src/ports/question'
import type { ToolCallContext, ToolOutcome } from '../../../src/ports/tools'

interface WorkContext {
  readonly projectId: string
  readonly workdir: string
}

/** 规则 4/10/12/15/21/24/25：产出物、任务与询问的端到端闭环 */
describe('API · 产出物 / 任务 / 询问（规则 4/10/12/15/21/24/25）', () => {
  let context: TestContext
  let work: WorkContext

  beforeAll(async () => {
    context = await createTestServer()
    const workdir = mkdtempSync(join(tmpdir(), 'ah-work-api-'))
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '产出物与任务演示', workdir },
    })
    work = { projectId: created.json<{ id: string }>().id, workdir }
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  const callTool = async (name: string, args: unknown, instanceId: string, turn = 1): Promise<ToolOutcome> => {
    const entry = context.deps.toolRegistry.get(name)
    expect(entry).toBeDefined()
    if (entry === undefined) throw new Error(`工具未注册：${name}`)
    const toolContext: ToolCallContext = {
      projectId: work.projectId,
      instanceId,
      sessionId: `u_${instanceId}`,
      sessionType: 'user',
      turn,
      sourceSeq: turn,
      roots: { workdir: work.workdir, runtime: join(process.cwd(), 'data', 'projects', work.projectId), readonly: [] },
      requestApproval: async () => ({ ok: true, value: { decision: 'approved' as const, approvalId: 'ap_test' } }),
      signal: new AbortController().signal,
    }
    return entry.handler(args, toolContext)
  }

  it('规则 21 / 4：workdir_edit 首写认领 + 二次修改 + 他人写入被拒；产出物登记进 manifest', async () => {
    const first = await callTool('workdir_edit', { path: 'workdir://docs/prd.md', content: '# PRD v1' }, 'pm_1')
    expect(first.ok).toBe(true)
    expect(first.text).toContain('已新建 docs/prd.md')

    const mine = await callTool('workdir_edit', { path: 'workdir://docs/prd.md', content: '# PRD v1\n\n目标' }, 'pm_1')
    expect(mine.ok && mine.text).toContain('已修改')

    const others = await callTool('workdir_edit', { path: 'workdir://docs/prd.md', content: '被别人覆盖' }, 'dev_1')
    expect(others.ok).toBe(false)
    expect(others.errorCode).toBe('ERR_FORBIDDEN')
    expect(others.text).toContain('项目经理')
    expect(readFileSync(join(work.workdir, 'docs/prd.md'), 'utf8')).toContain('目标')

    const owners = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/file-owners?owner=pm_1` })
    expect(owners.statusCode).toBe(200)
    const records = owners.json<FileOwnerRecord[]>()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ relPath: 'docs/prd.md', owner: 'pm_1', ownerName: '项目经理', edits: 2 })

    const submitted = await callTool(
      'artifact_submit',
      { title: 'PRD', summary: '产品需求文档', type: 'doc' },
      'pm_1',
    )
    expect(submitted.ok).toBe(true)
    expect(submitted.text).toContain('v1')
    expect(submitted.data?.['versionDir']).toBeTruthy()

    const list = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/artifacts` })
    const artifacts = list.json<ArtifactRecord[]>()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ type: 'doc', title: 'PRD', version: 1, state: 'approved', taskId: null })
    expect(artifacts[0]?.files.map((file) => file.relPath)).toEqual(['docs/prd.md'])

    const versions = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/artifacts/${artifacts[0]?.id}/versions`,
    })
    expect(versions.json<ArtifactRecord[]>().map((item) => item.version)).toEqual([1])
  })

  it('规则 10：用户经接口回退到指定版本，工作目录内容与版本快照一致', async () => {
    const list = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/artifacts` })
    const artifact = list.json<ArtifactRecord[]>()[0]
    if (artifact === undefined) throw new Error('缺少产出物')

    const rolled = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/rollback`,
      payload: { version: 1, force: true },
    })
    expect(rolled.statusCode).toBe(200)
    const record = rolled.json<ArtifactRecord>()
    expect(record).toMatchObject({ state: 'reverted', version: 2, revertedTo: 1 })
    // v1 是 add → 回退即删除文件（内容回到 v1 之前）
    expect(() => readFileSync(join(work.workdir, 'docs/prd.md'), 'utf8')).toThrow()

    const versions = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/versions`,
    })
    expect(versions.json<ArtifactRecord[]>().map((item) => item.state)).toEqual(['approved', 'reverted'])

    // S54/D58：未知回退方式被拒
    const badMode = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/rollback`,
      payload: { version: 1, mode: 'nope' },
    })
    expect(badMode.statusCode).toBe(400)
    expect(badMode.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    // S54/D58：mode=restore 退回到 v1 的**内容**（v2 删掉的 prd 被写回，而不是再删一次）
    const restored = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/rollback`,
      payload: { version: 1, mode: 'restore' },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json<ArtifactRecord>()).toMatchObject({
      state: 'reverted',
      version: 3,
      revertedTo: 1,
      revertMode: 'restore',
    })
    expect(readFileSync(join(work.workdir, 'docs/prd.md'), 'utf8')).toContain('目标')

    // 已是最新版本 → 没有可退回的东西
    const noop = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/rollback`,
      payload: { version: 3, mode: 'restore' },
    })
    expect(noop.statusCode).toBe(400)
    expect(noop.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    const afterRestore = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/artifacts/${artifact.id}/versions`,
    })
    expect(afterRestore.json<ArtifactRecord[]>().map((item) => item.version)).toEqual([1, 2, 3])
  })

  it('规则 15/24：任务发布（去重）→ 领取 → 汇报闭环，每 Agent 单 in_progress', async () => {
    const created = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/tasks`,
      payload: { assignee: 'dev_1', title: '实现登录模块', desc: '按 PRD 实现并自测' },
    })
    expect(created.statusCode).toBe(201)
    const task = created.json<{ task: TaskRecord; duplicate: boolean }>()
    expect(task).toMatchObject({ duplicate: false })
    expect(task.task.state).toBe('todo')

    // 撞车去重：同受派人 + 归一化标题 → 200 + duplicate
    const duplicate = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/tasks`,
      payload: { assignee: 'dev_1', title: ' 实现登录模块！' },
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json<{ duplicate: boolean }>().duplicate).toBe(true)

    // 发布即通知受派人（系统消息进 user 会话）
    const log = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/sessions/u_dev_1/log` })
    const notices = log
      .json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      .filter((event) => event.kind === 'message' && event.payload['sender'] === 'system')
    expect(notices.length).toBeGreaterThan(0)
    expect(String(notices[0]?.payload['text'])).toContain('待领取任务')

    const claimed = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.task.id}`,
      payload: { state: 'in_progress', actor: 'dev_1' },
    })
    expect(claimed.statusCode).toBe(200)
    expect(claimed.json<TaskRecord>().state).toBe('in_progress')

    // S51/D54：领取后，状态投影带上"正在执行的任务"（会话顶部展示用）
    const agents = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/agents` })
    const devView = agents
      .json<Array<{ instanceId: string; currentTask: { id: string; title: string; state: string } | null }>>()
      .find((item) => item.instanceId === 'dev_1')
    expect(devView?.currentTask).toMatchObject({ id: task.task.id, title: '实现登录模块', state: 'in_progress' })
    // 其它角色不受影响（各看各的）
    const pmView = agents
      .json<Array<{ instanceId: string; currentTask: unknown }>>()
      .find((item) => item.instanceId === 'pm_1')
    expect(pmView?.currentTask).toBeNull()

    // 单 in_progress：另起一条任务置位被拦
    const another = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/tasks`,
      payload: { assignee: 'dev_1', title: '另一个任务' },
    })
    const anotherTask = another.json<{ task: TaskRecord }>().task
    const blocked = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${anotherTask.id}`,
      payload: { state: 'in_progress', actor: 'dev_1' },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json<{ code: string }>().code).toBe('ERR_CONFLICT')

    // 进行中任务进入上下文（activeFor）
    const preview = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/agents/dev_1/system-prompt`,
    })
    const blocks = preview.json<{ blocks: Array<{ id: string; text: string }> }>().blocks
    expect(blocks.find((block) => block.id === 'task-context')?.text).toContain('实现登录模块')

    // 汇报完成 → 任务 done
    const done = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.task.id}`,
      payload: { state: 'done', actor: 'dev_1', note: '已完成' },
    })
    expect(done.statusCode).toBe(200)
    expect(done.json<TaskRecord>()).toMatchObject({ state: 'done', note: '已完成' })

    // S51/D54：任务收口后，会话顶部的"正在执行"随之清空
    const afterDone = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/agents` })
    const devAfter = afterDone
      .json<Array<{ instanceId: string; currentTask: unknown }>>()
      .find((item) => item.instanceId === 'dev_1')
    expect(devAfter?.currentTask).toBeNull()

    // S55/D59：老板（缺省 actor=user）可以把 done 的任务直接改回「进行中」重新开工
    const reopened = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.task.id}`,
      payload: { state: 'in_progress' },
    })
    expect(reopened.statusCode).toBe(200)
    expect(reopened.json<TaskRecord>().state).toBe('in_progress')

    // 激活即唤醒：受派人的 user 会话里出现"置为进行中"的系统消息（否则状态改了角色不知道要开工）
    const logAfterReopen = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/sessions/u_dev_1/log` })
    const activationTexts = logAfterReopen
      .json<Array<{ kind: string; payload: Record<string, unknown> }>>()
      .filter((event) => event.kind === 'message' && event.payload['sender'] === 'system')
      .map((event) => String(event.payload['text']))
    expect(activationTexts.some((text) => text.includes('置为进行中'))).toBe(true)

    // Agent 侧口径不变：仍不允许绕过 todo 直接开工（同一动作 actor=dev_1 → 409）
    const closedAgain = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.task.id}`,
      payload: { state: 'done', actor: 'dev_1' },
    })
    expect(closedAgain.statusCode).toBe(200)
    const agentBypass = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.task.id}`,
      payload: { state: 'in_progress', actor: 'dev_1' },
    })
    expect(agentBypass.statusCode).toBe(409)
    expect(agentBypass.json<{ code: string }>().code).toBe('ERR_CONFLICT')
  })

  it('规则 12：任务级代码聚合——进行中任务的编辑按 taskId 暂存，任务 done 后结算为 code artifact', async () => {
    const list = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/tasks?assignee=dev_1&state=todo` })
    const task = list.json<TaskRecord[]>()[0]
    if (task === undefined) throw new Error('缺少待领取任务')
    await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.id}`,
      payload: { state: 'in_progress', actor: 'dev_1' },
    })

    const edited = await callTool('workdir_edit', { path: 'workdir://src/login.ts', content: 'export const login = 1' }, 'dev_1')
    expect(edited.ok).toBe(true)

    const pending = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/pending-edits?key=task-${task.id}`,
    })
    expect(pending.statusCode).toBe(200)
    const body = pending.json<{ files: number; diffSummary: { add: number; del: number }; edits: unknown[] }>()
    expect(body.files).toBe(1)
    expect(body.diffSummary.add).toBe(1)

    const settled = await inject({
      method: 'PATCH',
      url: `/api/projects/${work.projectId}/tasks/${task.id}`,
      payload: { state: 'done', actor: 'dev_1' },
    })
    const doneTask = settled.json<TaskRecord>()
    expect(doneTask.artifactIds).toHaveLength(1)

    const artifacts = await inject({
      method: 'GET',
      url: `/api/projects/${work.projectId}/artifacts?taskId=${task.id}`,
    })
    const codes = artifacts.json<ArtifactRecord[]>()
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatchObject({ type: 'code', taskId: task.id, state: 'approved' })
    expect(codes[0]?.files.map((file) => file.relPath)).toEqual(['src/login.ts'])
  })

  it('规则 25：询问列表与答复接口（pending → answered），重复答复 409', async () => {
    const asked = await context.deps.questions.ask({
      projectId: work.projectId,
      sessionId: 'u_qa_1',
      asker: 'qa_1',
      title: '回归范围选哪个？',
      items: [{ text: '范围', options: ['全量', '核心'] }],
    })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const pending = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/questions?status=pending` })
    expect(pending.json<QuestionRecord[]>()).toHaveLength(1)
    expect(pending.json<QuestionRecord[]>()[0]).toMatchObject({ asker: 'qa_1', title: '回归范围选哪个？' })

    const answered = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/questions/${asked.value.id}/answer`,
      payload: { answers: [{ itemId: 'i_1', choice: '核心' }] },
    })
    expect(answered.statusCode).toBe(200)
    expect(answered.json<QuestionRecord>()).toMatchObject({ status: 'answered' })

    const again = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/questions/${asked.value.id}/answer`,
      payload: { answers: [{ itemId: 'i_1', choice: '全量' }] },
    })
    expect(again.statusCode).toBe(409)

    const stillPending = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/questions?status=pending` })
    expect(stillPending.json<QuestionRecord[]>()).toHaveLength(0)
    // 答复会唤醒提问者（系统消息进 u_qa_1）
    const log = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/sessions/u_qa_1/log` })
    expect(
      log.json<Array<{ payload: Record<string, unknown> }>>().some((event) => String(event.payload['text']).includes('[询问]')),
    ).toBe(true)
  })

  it('参数校验：未知产出物类型 / 空 answers / 未知任务状态都被拒', async () => {
    const badType = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/artifacts?type=unknown` })
    expect(badType.statusCode).toBe(400)

    const badState = await inject({ method: 'GET', url: `/api/projects/${work.projectId}/tasks?state=unknown` })
    expect(badState.statusCode).toBe(400)

    const asked = await context.deps.questions.ask({
      projectId: work.projectId,
      sessionId: 'u_pm_1',
      asker: 'pm_1',
      title: '校验用问题',
      items: [{ text: 'x' }],
    })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return
    const empty = await inject({
      method: 'POST',
      url: `/api/projects/${work.projectId}/questions/${asked.value.id}/answer`,
      payload: { answers: [] },
    })
    expect(empty.statusCode).toBe(400)
  })
})
