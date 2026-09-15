import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRecoveryService } from '../../../src/application/recovery/recovery-service'
import { createRuntimeService } from '../../../src/application/runtime/runtime-service'
import { createProjectExporter } from '../../../src/application/runtime/exporter'
import { createEventPipeline } from '../../../src/application/session/event-pipeline'
import { createSessionMeta } from '../../../src/application/session/session-meta-factory'
import { createSessionService } from '../../../src/application/session/session-service'
import { createTaskService } from '../../../src/application/task/task-service'
import { createArtifactService } from '../../../src/application/artifact/artifact-service'
import { createOrchestrationService } from '../../../src/application/orchestration/orchestration-service'
import { createDispatcherStateStore } from '../../../src/infra/file-store/dispatcher-state-store'
import { createArtifactStore } from '../../../src/infra/file-store/artifact-store'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createOrchestrationStore } from '../../../src/infra/file-store/orchestration-store'
import { createProjectStore } from '../../../src/infra/file-store/project-store'
import { createSessionLogStore } from '../../../src/infra/file-store/session-log-store'
import { createSessionMetaStore } from '../../../src/infra/file-store/session-meta-store'
import { createTaskStore } from '../../../src/infra/file-store/task-store'
import { createWorkdirFs } from '../../../src/infra/fs/workdir-fs'
import { createZipWriter } from '../../../src/infra/archive/zip'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import { createTestLogger } from '../../helpers'
import { EMPTY_DISPATCHER_STATE, type Dispatcher, type DispatcherStateStore } from '../../../src/ports/dispatcher'
import type { ProjectMeta, RoleInstance } from '../../../src/ports/project'
import { ok } from '../../../src/shared/result'

const PROJECT = 'p_1'
const SESSION = 'u_dev_1'

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
  readonly sessions: ReturnType<typeof createSessionService>
  readonly recovery: ReturnType<typeof createRecoveryService>
  readonly runtime: ReturnType<typeof createRuntimeService>
  readonly exporter: ReturnType<typeof createProjectExporter>
  readonly tasks: ReturnType<typeof createTaskService>
  readonly artifacts: ReturnType<typeof createArtifactService>
  readonly wakes: string[]
  readonly stateStore: DispatcherStateStore
}

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ah-s8-'))
  const workdir = join(root, 'workdir')
  mkdirSync(workdir, { recursive: true })
  const fileStore = createFileStore({ root })
  const lock = createKeyedLockManager()
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const ids = createIdGenerator()
  const projects = createProjectStore({ fileStore, lock, clock, dataDir: 'data' })
  const metaStore = createSessionMetaStore({ fileStore, clock, dataDir: 'data' })
  const logStore = createSessionLogStore({ fileStore, metaStore, lock, clock, dataDir: 'data' })
  const meta: ProjectMeta = {
    schemaVersion: 1,
    id: PROJECT,
    name: 'S8 演示',
    description: '',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    workdir,
    workdirKind: 'empty',
    team: [instance('dev_1', '高级开发'), instance('qa_1', '测试')],
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: false },
    approvalPolicy: { highRiskCommands: true },
  }
  const created = await projects.create(meta)
  if (!created.ok) throw new Error(created.error.message)
  await metaStore.create(createSessionMeta({ sessionId: SESSION, projectId: PROJECT, instanceId: 'dev_1', nowIso: '2026-09-15T00:00:00.000Z' }))
  await metaStore.create(createSessionMeta({ sessionId: 'u_qa_1', projectId: PROJECT, instanceId: 'qa_1', nowIso: '2026-09-15T00:00:00.000Z' }))

  const pipeline = createEventPipeline({ logStore, broadcaster: { broadcast: () => undefined }, clock })
  const sessions = createSessionService({ metaStore, logStore, pipeline, projectStore: projects, clock })

  const artifacts = createArtifactService({
    store: createArtifactStore({ fileStore, lock, clock, dataDir: 'data' }),
    workdir: createWorkdirFs(),
    projects,
    lock,
    ids,
    clock,
    logger: createTestLogger(),
  })
  const orchestration = createOrchestrationService({
    store: createOrchestrationStore({ fileStore, lock, clock, dataDir: 'data' }),
    projects,
    ids,
    clock,
    broadcaster: { broadcast: () => undefined },
    logger: createTestLogger(),
  })
  const tasks = createTaskService({
    store: createTaskStore({ fileStore, lock, clock, dataDir: 'data' }),
    projects,
    artifacts,
    orchestration,
    ids,
    clock,
    broadcaster: { broadcast: () => undefined },
    logger: createTestLogger(),
    notify: async () => undefined,
  })

  const stateStore = createDispatcherStateStore({ fileStore, lock, clock, dataDir: 'data' })
  await stateStore.save(PROJECT, {
    ...EMPTY_DISPATCHER_STATE,
    occupancy: { dev_1: { type: 'user', sessionId: SESSION, since: '2026-09-15T00:00:05.000Z' } },
    turns: { dev_1: 2 },
  })

  const wakes: string[] = []
  const recovery = createRecoveryService({
    sessions,
    clock,
    wake: async (input) => {
      wakes.push(input.text)
    },
    projectSessions: async (projectId) => {
      const listed = await sessions.list(projectId)
      return listed.ok
        ? { ok: true as const, value: listed.value.map((item) => ({ sessionId: item.sessionId, instanceId: item.instanceId })) }
        : listed
    },
  })

  // 仅测试 stop 的 turn 分支：dispatcher 用最小替身（abortTurn 记录调用）
  const aborted: string[] = []
  const dispatcher = {
    abortTurn: (_projectId: string, instanceId: string) => {
      aborted.push(instanceId)
      return true
    },
    status: async () =>
      ok([
        {
          instanceId: 'dev_1',
          enabled: true,
          state: 'working' as const,
          paused: false,
          sessionId: SESSION,
          queued: 2,
        },
        { instanceId: 'qa_1', enabled: true, state: 'idle' as const, paused: false, sessionId: 'u_qa_1', queued: 0 },
      ]),
  } as unknown as Dispatcher

  return {
    sessions,
    recovery,
    wakes,
    stateStore,
    tasks,
    artifacts,
    runtime: createRuntimeService({
      projects,
      sessions,
      tasks,
      recovery,
      dispatcher,
      stateStore,
      clock,
      logger: createTestLogger(),
    }),
    exporter: createProjectExporter({
      fileStore,
      projects,
      zip: createZipWriter(),
      dataDir: 'data',
    }),
  }
}

/** 规则 19 / 14：未完成回合（缺 turn_end）判定与三选恢复 */
describe('application/recovery-service（规则 19/14）', () => {
  it('缺 turn_end → 判定为未完成回合；补上 turn_end 后消失', async () => {
    const harness = await createHarness()
    await harness.sessions.append(PROJECT, SESSION, [
      { kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1', loopStep: 'direct' } },
      { kind: 'message', turn: 1, payload: { role: 'user', text: '开始', content: { text: '开始' } } },
      { kind: 'turn_end', turn: 1, payload: { ok: true } },
      { kind: 'turn_start', turn: 2, payload: { turnId: 'turn_2', loopStep: 'plan-execute' } },
      { kind: 'plan', turn: 2, payload: { planId: 'pl_1', steps: [{ id: 's1' }, { id: 's2' }], status: 'running' } },
    ])

    const unfinished = await harness.recovery.unfinished(PROJECT, SESSION)
    expect(unfinished.ok && unfinished.value).toMatchObject({
      turn: 2,
      turnId: 'turn_2',
      loopStep: 'plan-execute',
      resolvedBy: null,
    })
    expect(unfinished.ok && unfinished.value?.lastPlan).toEqual({ steps: 2, status: 'running' })

    await harness.sessions.append(PROJECT, SESSION, [{ kind: 'turn_end', turn: 2, payload: { ok: true } }])
    const closed = await harness.recovery.unfinished(PROJECT, SESSION)
    expect(closed.ok && closed.value).toBeNull()
  })

  it('三选：report/continue 落 state 标记并唤醒一轮；ignore 只落标记；重复处理 ERR_CONFLICT', async () => {
    const harness = await createHarness()
    await harness.sessions.append(PROJECT, SESSION, [
      { kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1', loopStep: 'plan-execute' } },
      { kind: 'plan', turn: 1, payload: { steps: [{ id: 's1' }], status: 'interrupted' } },
    ])

    const reported = await harness.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 1, action: 'report' })
    expect(reported.ok && reported.value.resumed).toBe(true)
    expect(harness.wakes[0]).toContain('汇报')
    expect(harness.wakes[0]).toContain('turn 1')

    // 标记已落盘：不改变"缺 turn_end"事实，但带 resolvedBy
    const afterReport = await harness.recovery.unfinished(PROJECT, SESSION)
    expect(afterReport.ok && afterReport.value?.resolvedBy).toBe('report')

    const again = await harness.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 1, action: 'ignore' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('ERR_CONFLICT')

    // 忽略：只落标记、不唤醒
    const harness2 = await createHarness()
    await harness2.sessions.append(PROJECT, SESSION, [{ kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1' } }])
    const ignored = await harness2.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 1, action: 'ignore' })
    expect(ignored.ok && ignored.value.resumed).toBe(false)
    expect(harness2.wakes).toHaveLength(0)
    const afterIgnore = await harness2.recovery.unfinished(PROJECT, SESSION)
    expect(afterIgnore.ok && afterIgnore.value?.resolvedBy).toBe('ignore')
  })

  it('补全（complete）：唤醒文本要求补全被截断的回复', async () => {
    const harness = await createHarness()
    await harness.sessions.append(PROJECT, SESSION, [{ kind: 'turn_start', turn: 1, payload: { turnId: 'turn_1' } }])
    const completed = await harness.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 1, action: 'complete' })
    expect(completed.ok && completed.value.resumed).toBe(true)
    expect(harness.wakes[0]).toContain('补全')
  })

  it('已有完整回合（turn_end 齐全）时 resolve → ERR_NOT_FOUND；turn 不匹配 → ERR_CONFLICT', async () => {
    const harness = await createHarness()
    const none = await harness.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 1, action: 'report' })
    expect(!none.ok && none.error.code).toBe('ERR_NOT_FOUND')

    await harness.sessions.append(PROJECT, SESSION, [
      { kind: 'turn_start', turn: 3, payload: {} },
      { kind: 'turn_end', turn: 3, payload: { ok: true } },
      { kind: 'turn_start', turn: 4, payload: {} },
    ])
    const mismatch = await harness.recovery.resolve({ projectId: PROJECT, sessionId: SESSION, turn: 3, action: 'report' })
    expect(!mismatch.ok && mismatch.error.code).toBe('ERR_CONFLICT')

    const listed = await harness.recovery.listUnfinished(PROJECT)
    expect(listed.ok && listed.value.map((item) => item.turn)).toEqual([4])
  })
})

/** 规则 20：可停止（turn/task）与「n 个 Agent 正在工作」细条 */
describe('application/runtime-service（规则 20）', () => {
  it('snapshot：只列占用中的 Agent，含停靠时间/回合/任务标题/队列；idle 单独计数', async () => {
    const harness = await createHarness()
    await harness.sessions.append(PROJECT, SESSION, [
      { kind: 'turn_start', turn: 2, payload: { loopStep: 'plan-execute' } },
      { kind: 'plan', turn: 2, payload: { steps: [{ id: 's1' }], status: 'running' } },
    ])
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '实现登录模块',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: SESSION,
    })
    if (created.ok) await harness.tasks.claim(PROJECT, created.value.task.id, 'dev_1')

    const snapshot = await harness.runtime.snapshot(PROJECT)
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.working).toHaveLength(1)
    expect(snapshot.value.working[0]).toMatchObject({
      instanceId: 'dev_1',
      displayName: '高级开发',
      state: 'working',
      turn: 2,
      taskTitle: '实现登录模块',
      planStatus: 'running',
      unfinishedTurn: 2,
      queued: 2,
    })
    expect(snapshot.value.idle).toBe(1)
    expect(snapshot.value.queuedTotal).toBe(2)
  })

  it('stop(turn)：中断当前回合但保留队列、不动任务', async () => {
    const harness = await createHarness()
    const stopped = await harness.runtime.stop({ projectId: PROJECT, instanceId: 'dev_1', scope: 'turn' })
    expect(stopped.ok && stopped.value).toMatchObject({ aborted: true, taskId: null, settledArtifactId: null, queued: 2 })
  })

  it('stop(task)：终止当前任务并结算未结算改动为 code artifact', async () => {
    const harness = await createHarness()
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '改造支付流程',
      desc: '',
      creator: 'user',
      assignee: 'dev_1',
      sessionId: SESSION,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await harness.tasks.claim(PROJECT, created.value.task.id, 'dev_1')
    await harness.artifacts.editFile({
      projectId: PROJECT,
      instanceId: 'dev_1',
      relPath: 'src/pay.ts',
      content: 'export const pay = 1',
      taskId: created.value.task.id,
      sessionId: SESSION,
      turn: 2,
    })

    const stopped = await harness.runtime.stop({ projectId: PROJECT, instanceId: 'dev_1', scope: 'task' })
    expect(stopped.ok && stopped.value).toMatchObject({ aborted: true, taskId: created.value.task.id })
    expect(stopped.ok && stopped.value.settledArtifactId).not.toBeNull()

    const task = await harness.tasks.get(PROJECT, created.value.task.id)
    expect(task.ok && task.value.state).toBe('terminated')
    const artifact = await harness.artifacts.get(PROJECT, stopped.ok ? (stopped.value.settledArtifactId as string) : '')
    expect(artifact.ok && artifact.value).toMatchObject({ type: 'code', taskId: created.value.task.id })
  })
})

/** 项目导出 zip（contract.md §系统） */
describe('application/runtime/exporter + infra/archive/zip', () => {
  it('zip 写入器产出合法结构（本地头/中央目录/EOCD）且内容可回读', () => {
    const zip = createZipWriter()
    const buffer = zip.build([
      { path: 'a/b.json', content: '{"x":1}' },
      { path: 'README.txt', content: 'hi' },
    ])
    expect(buffer.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(buffer.subarray(buffer.length - 22, buffer.length - 18).toString('hex')).toBe('504b0506')
    const text = buffer.toString('utf8')
    expect(text).toContain('a/b.json')
    expect(text).toContain('{"x":1}')
    // 中央目录条数
    const eocd = buffer.subarray(buffer.length - 22)
    expect(eocd.readUInt16LE(10)).toBe(2)
  })

  it('导出运行时项目文件夹：含会话日志/编排图/说明，不含工作目录', async () => {
    const harness = await createHarness()
    await harness.sessions.append(PROJECT, SESSION, [
      { kind: 'message', turn: 1, payload: { role: 'user', text: '导出测试', content: { text: '导出测试' } } },
    ])
    const exported = await harness.exporter.export(PROJECT)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.value.fileName).toBe(`${PROJECT}.zip`)
    expect(exported.value.bytes).toBeGreaterThan(0)
    const text = exported.value.content.toString('utf8')
    expect(text).toContain('EXPORT-README.txt')
    expect(text).toContain('sessions/u_dev_1.log.jsonl')
    expect(text).toContain('导出测试')
  })

  it('项目不存在 → ERR_NOT_FOUND', async () => {
    const harness = await createHarness()
    const missing = await harness.exporter.export('p_missing')
    expect(!missing.ok && missing.error.code).toBe('ERR_NOT_FOUND')
  })
})
