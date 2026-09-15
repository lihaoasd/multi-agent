import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createArtifactService } from '../../../src/application/artifact/artifact-service'
import { createQuestionService } from '../../../src/application/question/question-service'
import { createTaskService, normalizeTaskTitle } from '../../../src/application/task/task-service'
import { createArtifactStore } from '../../../src/infra/file-store/artifact-store'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createProjectStore } from '../../../src/infra/file-store/project-store'
import { createQuestionStore } from '../../../src/infra/file-store/question-store'
import { createTaskStore } from '../../../src/infra/file-store/task-store'
import { createWorkdirFs } from '../../../src/infra/fs/workdir-fs'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import { createTestLogger } from '../../helpers'
import type { ProjectMeta, RoleInstance } from '../../../src/ports/project'

const PROJECT = 'p_1'

function instance(instanceId: string, displayName: string): RoleInstance {
  return {
    instanceId,
    roleTemplateId: 'dev',
    displayName,
    prompt: null,
    model: null,
    loop: null,
    enabled: true,
    configVersion: 1,
    createdAt: '2026-09-15T00:00:00.000Z',
    snapshot: {
      roleTemplateId: 'dev',
      templateName: displayName,
      systemPrompt: '你是开发',
      defaultModel: null,
      defaultLoop: { strategy: 'direct', params: {} },
      packages: [],
      tools: [],
      artifactTypes: ['code'],
      defaultApprovalRules: [],
      capturedAt: '2026-09-15T00:00:00.000Z',
    },
  }
}

interface Harness {
  readonly tasks: ReturnType<typeof createTaskService>
  readonly questions: ReturnType<typeof createQuestionService>
  readonly artifacts: ReturnType<typeof createArtifactService>
  readonly notices: { projectId: string; instanceId: string; text: string }[]
}

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ah-work-'))
  const workdir = join(root, 'workdir')
  mkdirSync(workdir, { recursive: true })
  const fileStore = createFileStore({ root })
  const lock = createKeyedLockManager()
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const projects = createProjectStore({ fileStore, lock, clock, dataDir: 'data' })
  const meta: ProjectMeta = {
    schemaVersion: 1,
    id: PROJECT,
    name: '任务演示',
    description: '',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    workdir,
    workdirKind: 'empty',
    team: [instance('dev_1', '高级开发'), instance('qa_1', '测试'), instance('pm_1', '产品经理')],
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: false },
    approvalPolicy: { highRiskCommands: true },
  }
  const created = await projects.create(meta)
  if (!created.ok) throw new Error(created.error.message)

  const notices: { projectId: string; instanceId: string; text: string }[] = []
  const notify = async (input: { projectId: string; instanceId: string; text: string }): Promise<void> => {
    notices.push(input)
  }
  const broadcaster = { broadcast: vi.fn() }
  const ids = createIdGenerator()
  const artifacts = createArtifactService({
    store: createArtifactStore({ fileStore, lock, clock, dataDir: 'data' }),
    workdir: createWorkdirFs(),
    projects,
    lock,
    ids,
    clock,
    logger: createTestLogger(),
  })
  return {
    notices,
    artifacts,
    tasks: createTaskService({
      store: createTaskStore({ fileStore, lock, clock, dataDir: 'data' }),
      projects,
      artifacts,
      ids,
      clock,
      broadcaster,
      logger: createTestLogger(),
      notify,
    }),
    questions: createQuestionService({
      store: createQuestionStore({ fileStore, lock, clock, dataDir: 'data' }),
      broadcaster,
      ids,
      clock,
      logger: createTestLogger(),
      notify,
    }),
  }
}

/** 规则 15/17/24：发布→领取→汇报、单 in_progress、终止前结算 */
describe('application/task-service（规则 15/17/24）', () => {
  it('发布任务入 todo 并通知受派人；同受派人同题去重（force 可强制新建）', async () => {
    const harness = await createHarness()
    const first = await harness.tasks.create({
      projectId: PROJECT,
      title: '实现登录模块',
      desc: '按 PRD',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(first.ok && first.value.task.state).toBe('todo')
    expect(first.ok && first.value.duplicate).toBe(false)
    expect(harness.notices[0]).toMatchObject({ instanceId: 'dev_1' })
    expect(harness.notices[0]?.text).toContain('待领取')

    const duplicate = await harness.tasks.create({
      projectId: PROJECT,
      title: ' 实现登录模块！',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(duplicate.ok && duplicate.value.duplicate).toBe(true)
    expect(duplicate.ok && duplicate.value.task.id).toBe(first.ok ? first.value.task.id : '')

    const forced = await harness.tasks.create({
      projectId: PROJECT,
      title: '实现登录模块',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
      force: true,
    })
    expect(forced.ok && forced.value.duplicate).toBe(false)

    const listed = await harness.tasks.list(PROJECT, { assignee: 'dev_1' })
    expect(listed.ok && listed.value).toHaveLength(2)
  })

  it('todo 不入上下文：activeFor 只有 in_progress；领取后才有', async () => {
    const harness = await createHarness()
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '写单元测试',
      desc: '',
      creator: 'user',
      assignee: 'qa_1',
      sessionId: 'u_qa_1',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const beforeClaim = await harness.tasks.activeFor(PROJECT, 'qa_1')
    expect(beforeClaim.ok && beforeClaim.value).toBeNull()

    const claimed = await harness.tasks.claim(PROJECT, created.value.task.id, 'qa_1')
    expect(claimed.ok && claimed.value.state).toBe('in_progress')
    const afterClaim = await harness.tasks.activeFor(PROJECT, 'qa_1')
    expect(afterClaim.ok && afterClaim.value?.id).toBe(created.value.task.id)
  })

  it('规则 15/17：每 Agent 至多 1 个 in_progress——已有进行中任务时，领取/置位都被拦', async () => {
    const harness = await createHarness()
    const a = await harness.tasks.create({
      projectId: PROJECT,
      title: '任务 A',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    const b = await harness.tasks.create({
      projectId: PROJECT,
      title: '任务 B',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    await harness.tasks.claim(PROJECT, a.value.task.id, 'dev_1')
    const blocked = await harness.tasks.claim(PROJECT, b.value.task.id, 'dev_1')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('ERR_CONFLICT')
      expect(blocked.error.detail?.['holding']).toBe(a.value.task.id)
    }
    // 无自动回退：B 仍是 todo
    const bAfter = await harness.tasks.get(PROJECT, b.value.task.id)
    expect(bAfter.ok && bAfter.value.state).toBe('todo')

    // 置位（非受派人干预）同样被拦
    const forced = await harness.tasks.setState(PROJECT, b.value.task.id, 'in_progress', { actor: 'user' })
    expect(forced.ok).toBe(false)

    // 完成 A 后槽位释放，B 可以领取
    const done = await harness.tasks.setState(PROJECT, a.value.task.id, 'done', { actor: 'dev_1' })
    expect(done.ok && done.value.state).toBe('done')
    const claimedB = await harness.tasks.claim(PROJECT, b.value.task.id, 'dev_1')
    expect(claimedB.ok && claimedB.value.state).toBe('in_progress')
  })

  it('领取越权 / 重复领取：ERR_FORBIDDEN 与 ERR_CONFLICT', async () => {
    const harness = await createHarness()
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '部署脚本',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const wrong = await harness.tasks.claim(PROJECT, created.value.task.id, 'qa_1')
    expect(!wrong.ok && wrong.error.code).toBe('ERR_FORBIDDEN')
    await harness.tasks.claim(PROJECT, created.value.task.id, 'dev_1')
    const again = await harness.tasks.claim(PROJECT, created.value.task.id, 'dev_1')
    expect(!again.ok && again.error.code).toBe('ERR_CONFLICT')
  })

  it('规则 24：done/blocked/terminated 汇报并回报委派人（用户创建则不通知自己）', async () => {
    const harness = await createHarness()
    const fromAgent = await harness.tasks.create({
      projectId: PROJECT,
      title: '评审登录方案',
      desc: '',
      creator: 'pm_1',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(fromAgent.ok).toBe(true)
    if (!fromAgent.ok) return
    harness.notices.length = 0

    await harness.tasks.claim(PROJECT, fromAgent.value.task.id, 'dev_1')
    const done = await harness.tasks.setState(PROJECT, fromAgent.value.task.id, 'done', {
      actor: 'dev_1',
      note: '已完成并自测',
    })
    expect(done.ok && done.value.note).toBe('已完成并自测')
    expect(harness.notices.map((item) => item.instanceId)).toContain('pm_1')
    expect(harness.notices.find((item) => item.instanceId === 'pm_1')?.text).toContain('done')

    const byUser = await harness.tasks.create({
      projectId: PROJECT,
      title: '用户直接派的任务',
      desc: '',
      creator: 'user',
      assignee: 'qa_1',
      sessionId: 'u_qa_1',
    })
    expect(byUser.ok).toBe(true)
    if (!byUser.ok) return
    harness.notices.length = 0
    await harness.tasks.claim(PROJECT, byUser.value.task.id, 'qa_1')
    await harness.tasks.setState(PROJECT, byUser.value.task.id, 'blocked', { actor: 'qa_1', note: '缺测试环境' })
    expect(harness.notices).toHaveLength(0)
  })

  it('规则 17：终止前先结算未结算改动为可回退的 code artifact', async () => {
    const harness = await createHarness()
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '改造支付流程',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const taskId = created.value.task.id
    await harness.tasks.claim(PROJECT, taskId, 'dev_1')

    await harness.artifacts.editFile({
      projectId: PROJECT,
      instanceId: 'dev_1',
      relPath: 'src/pay.ts',
      content: 'export const pay = () => {}',
      taskId,
      sessionId: 'u_dev_1',
      turn: 2,
    })

    const terminated = await harness.tasks.setState(PROJECT, taskId, 'terminated', { actor: 'user', note: '需求取消' })
    expect(terminated.ok).toBe(true)
    if (!terminated.ok) return
    expect(terminated.value.artifactIds).toHaveLength(1)

    const artifact = await harness.artifacts.get(PROJECT, terminated.value.artifactIds[0] as string)
    expect(artifact.ok && artifact.value).toMatchObject({ type: 'code', taskId, state: 'approved' })
    expect(artifact.ok && artifact.value.files.map((file) => file.relPath)).toEqual(['src/pay.ts'])

    // 结算后可回退（内容依据在版本目录里）
    const rollback = await harness.artifacts.rollback({
      projectId: PROJECT,
      instanceId: 'dev_1',
      artifactId: terminated.value.artifactIds[0] as string,
      version: 1,
      sessionId: 'u_dev_1',
      turn: 3,
    })
    expect(rollback.ok && rollback.value.state).toBe('reverted')
  })

  it('normalizeTaskTitle 归一去重口径（空白/标点/大小写）', () => {
    expect(normalizeTaskTitle('实现 登录模块！')).toBe(normalizeTaskTitle('实现登录模块'))
    expect(normalizeTaskTitle('Fix LOGIN bug')).toBe('fixloginbug')
  })
})

/** 规则 25：询问阻塞与答复续跑 */
describe('application/question-service（规则 25）', () => {
  it('提问落 pending 并阻塞等待；答复后唤醒，同一 Agent 第二个提问被拒', async () => {
    const harness = await createHarness()
    const asked = await harness.questions.ask({
      projectId: PROJECT,
      sessionId: 'u_dev_1',
      asker: 'dev_1',
      title: '登录方案选哪个？',
      items: [{ text: '方案', options: ['A', 'B'] }],
    })
    expect(asked.ok && asked.value.status).toBe('pending')
    expect(asked.ok && asked.value.items[0]).toMatchObject({ id: 'i_1', options: ['A', 'B'], required: true })
    // Agent 状态投影的 waiting 依据
    expect(await harness.questions.hasPending(PROJECT, 'dev_1')).toBe(true)

    const second = await harness.questions.ask({
      projectId: PROJECT,
      sessionId: 'u_dev_1',
      asker: 'dev_1',
      title: '再问一个',
      items: [{ text: 'x' }],
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('ERR_QUESTION_PENDING')

    // 其他角色不受影响（各自最多 1 个 pending）
    expect(
      (
        await harness.questions.ask({
          projectId: PROJECT,
          sessionId: 'u_qa_1',
          asker: 'qa_1',
          title: '测试环境用哪个？',
          items: [{ text: '环境' }],
        })
      ).ok,
    ).toBe(true)

    if (!asked.ok) return
    const controller = new AbortController()
    const waiting = harness.questions.waitForAnswer(PROJECT, asked.value.id, controller.signal)
    const answered = await harness.questions.answer(PROJECT, asked.value.id, [
      { itemId: 'i_1', choice: 'A', text: null },
    ])
    expect(answered.ok && answered.value.status).toBe('answered')
    const resumed = await waiting
    expect(resumed.ok && resumed.value.answer?.answers[0]).toMatchObject({ itemId: 'i_1', choice: 'A' })
    expect(await harness.questions.hasPending(PROJECT, 'dev_1')).toBe(false)
    // 答复会唤醒提问者一轮（系统消息 + drain 由组合根提供）
    expect(harness.notices.some((item) => item.instanceId === 'dev_1' && item.text.includes('询问'))).toBe(true)
  })

  it('必答项缺失 → ERR_VALIDATION；重复答复 → ERR_CONFLICT；回合取消打断等待', async () => {
    const harness = await createHarness()
    const asked = await harness.questions.ask({
      projectId: PROJECT,
      sessionId: 'u_qa_1',
      asker: 'qa_1',
      title: '问题清单',
      items: [{ text: '必答 1' }, { text: '可选 2', required: false }],
    })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const missing = await harness.questions.answer(PROJECT, asked.value.id, [
      { itemId: 'i_2', choice: null, text: '只答了可选' },
    ])
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe('ERR_VALIDATION')
      expect(missing.error.detail?.['missing']).toEqual(['i_1'])
    }

    const controller = new AbortController()
    const waiting = harness.questions.waitForAnswer(PROJECT, asked.value.id, controller.signal)
    controller.abort()
    const aborted = await waiting
    expect(aborted.ok).toBe(false)

    await harness.questions.answer(PROJECT, asked.value.id, [{ itemId: 'i_1', choice: null, text: '答案' }])
    const again = await harness.questions.answer(PROJECT, asked.value.id, [{ itemId: 'i_1', choice: null, text: '再答' }])
    expect(!again.ok && again.error.code).toBe('ERR_CONFLICT')
  })

  it('参数校验：空标题 / 无问题项 / 选项过多都被拒', async () => {
    const harness = await createHarness()
    expect(
      (await harness.questions.ask({ projectId: PROJECT, sessionId: 'u_dev_1', asker: 'dev_1', title: '  ', items: [{ text: 'x' }] })).ok,
    ).toBe(false)
    expect(
      (await harness.questions.ask({ projectId: PROJECT, sessionId: 'u_dev_1', asker: 'dev_1', title: '标题', items: [] })).ok,
    ).toBe(false)
    const tooManyOptions = await harness.questions.ask({
      projectId: PROJECT,
      sessionId: 'u_dev_1',
      asker: 'dev_1',
      title: '标题',
      items: [{ text: 'x', options: Array.from({ length: 9 }, (_, index) => `o${index}`) }],
    })
    expect(tooManyOptions.ok).toBe(false)
    if (!tooManyOptions.ok) expect(tooManyOptions.error.code).toBe('ERR_VALIDATION')
  })
})
