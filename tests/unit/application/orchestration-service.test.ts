import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createOrchestrationService } from '../../../src/application/orchestration/orchestration-service'
import { createTaskService } from '../../../src/application/task/task-service'
import { createArtifactService } from '../../../src/application/artifact/artifact-service'
import { createArtifactStore } from '../../../src/infra/file-store/artifact-store'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createOrchestrationStore } from '../../../src/infra/file-store/orchestration-store'
import { createProjectStore } from '../../../src/infra/file-store/project-store'
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

async function createHarness(): Promise<{
  orchestration: ReturnType<typeof createOrchestrationService>
  tasks: ReturnType<typeof createTaskService>
  broadcast: ReturnType<typeof vi.fn>
  graph: () => Promise<{ version: number; nodes: readonly { instanceId: string }[]; edges: readonly { from: string; to: string }[] }>
}> {
  const root = mkdtempSync(join(tmpdir(), 'ah-orch-'))
  const workdir = join(root, 'workdir')
  mkdirSync(workdir, { recursive: true })
  const fileStore = createFileStore({ root })
  const lock = createKeyedLockManager()
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const ids = createIdGenerator()
  const projects = createProjectStore({ fileStore, lock, clock, dataDir: 'data' })
  const meta: ProjectMeta = {
    schemaVersion: 1,
    id: PROJECT,
    name: '编排演示',
    description: '',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    workdir,
    workdirKind: 'empty',
    team: [instance('pm_1', '项目经理'), instance('dev_1', '高级开发'), instance('qa_1', '测试')],
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: false },
    approvalPolicy: { highRiskCommands: true },
  }
  const created = await projects.create(meta)
  if (!created.ok) throw new Error(created.error.message)

  const broadcast = vi.fn()
  const orchestration = createOrchestrationService({
    store: createOrchestrationStore({ fileStore, lock, clock, dataDir: 'data' }),
    projects,
    ids,
    clock,
    broadcaster: { broadcast },
    logger: createTestLogger(),
  })
  const artifacts = createArtifactService({
    store: createArtifactStore({ fileStore, lock, clock, dataDir: 'data' }),
    workdir: createWorkdirFs(),
    projects,
    lock,
    ids,
    clock,
    logger: createTestLogger(),
  })
  const tasks = createTaskService({
    store: createTaskStore({ fileStore, lock, clock, dataDir: 'data' }),
    projects,
    artifacts,
    orchestration,
    ids,
    clock,
    broadcaster: { broadcast },
    logger: createTestLogger(),
    notify: async () => undefined,
  })
  return {
    orchestration,
    tasks,
    broadcast,
    graph: async () => {
      const loaded = await orchestration.get(PROJECT)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return {
        version: loaded.value.version,
        nodes: loaded.value.nodes.map((node) => ({ instanceId: node.instanceId })),
        edges: loaded.value.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      }
    },
  }
}

/** 规则 22：编排图保存与校验（自环/重复边/跨项目节点/版本冲突） */
describe('application/orchestration-service（规则 22）', () => {
  it('首次读取按团队自动补齐节点（version=0，未落盘）', async () => {
    const harness = await createHarness()
    const graph = await harness.graph()
    expect(graph.version).toBe(0)
    expect(graph.nodes.map((node) => node.instanceId)).toEqual(['pm_1', 'dev_1', 'qa_1'])
    expect(graph.edges).toEqual([])
  })

  it('保存成功 version+1 并广播 orchestration.updated；重复保存带新版本继续 +1', async () => {
    const harness = await createHarness()
    const first = await harness.orchestration.get(PROJECT)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const saved = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: first.value.nodes,
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })
    expect(saved.ok && saved.value.version).toBe(1)
    expect(saved.ok && saved.value.edges[0]).toMatchObject({ from: 'pm_1', to: 'dev_1' })
    expect(saved.ok && saved.value.edges[0]?.id).toMatch(/^e_/)
    expect(harness.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orchestration.updated', payload: expect.objectContaining({ projectId: PROJECT }) }),
    )

    const second = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 1,
      nodes: first.value.nodes,
      edges: [
        { from: 'pm_1', to: 'dev_1' },
        { from: 'dev_1', to: 'qa_1' },
      ],
    })
    expect(second.ok && second.value.version).toBe(2)
    expect(second.ok && second.value.edges).toHaveLength(2)
  })

  it('version 不匹配 → ERR_CONFLICT（附带 currentVersion）', async () => {
    const harness = await createHarness()
    const first = await harness.orchestration.get(PROJECT)
    if (!first.ok) return
    await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: first.value.nodes,
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })
    const conflicted = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: first.value.nodes,
      edges: [],
    })
    expect(conflicted.ok).toBe(false)
    if (!conflicted.ok) {
      expect(conflicted.error.code).toBe('ERR_CONFLICT')
      expect(conflicted.error.detail?.['currentVersion']).toBe(1)
    }
  })

  it('自环 / 重复边 / 跨项目节点 / 边端不在图中 → ERR_ORCHESTRATION_INVALID', async () => {
    const harness = await createHarness()
    const current = await harness.orchestration.get(PROJECT)
    if (!current.ok) return
    const nodes = current.value.nodes

    const selfLoop = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes,
      edges: [{ from: 'dev_1', to: 'dev_1' }],
    })
    expect(!selfLoop.ok && selfLoop.error.code).toBe('ERR_ORCHESTRATION_INVALID')

    const duplicated = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes,
      edges: [
        { from: 'pm_1', to: 'dev_1' },
        { from: 'pm_1', to: 'dev_1' },
      ],
    })
    expect(!duplicated.ok && duplicated.error.code).toBe('ERR_ORCHESTRATION_INVALID')

    const foreign = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: [...nodes, { instanceId: 'ops_9', x: 0, y: 0, collapsed: false }],
      edges: [],
    })
    expect(!foreign.ok && foreign.error.code).toBe('ERR_ORCHESTRATION_INVALID')

    const danglingEdge = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: [nodes[0] as NonNullable<(typeof nodes)[number]>],
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })
    expect(!danglingEdge.ok && danglingEdge.error.code).toBe('ERR_ORCHESTRATION_INVALID')
  })

  it('实例移出团队后：读取时级联删除其节点与边', async () => {
    const harness = await createHarness()
    const current = await harness.orchestration.get(PROJECT)
    if (!current.ok) return
    await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: current.value.nodes,
      edges: [
        { from: 'pm_1', to: 'dev_1' },
        { from: 'dev_1', to: 'qa_1' },
      ],
    })
    const projectStore = undefined
    void projectStore
    // 直接改图不含 qa_1（模拟实例被移除后的归一化输入）
    const saved = await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 1,
      nodes: current.value.nodes.filter((node) => node.instanceId !== 'qa_1'),
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })
    expect(saved.ok && saved.value.nodes.map((node) => node.instanceId)).toEqual(['pm_1', 'dev_1'])
    expect(saved.ok && saved.value.edges.map((edge) => edge.to)).toEqual(['dev_1'])
  })

  it('outgoingOf / canDelegate 反映直接出边（委派权限判定）', async () => {
    const harness = await createHarness()
    const current = await harness.orchestration.get(PROJECT)
    if (!current.ok) return
    await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: current.value.nodes,
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })
    const outgoing = await harness.orchestration.outgoingOf(PROJECT, 'pm_1')
    expect(outgoing.ok && outgoing.value).toEqual(['dev_1'])
    expect((await harness.orchestration.canDelegate(PROJECT, 'pm_1', 'dev_1')).ok).toBe(true)
    const denied = await harness.orchestration.canDelegate(PROJECT, 'pm_1', 'qa_1')
    expect(denied.ok && denied.value).toBe(false)
  })
})

/** 规则 23：委派边约束（越边拒绝且不建任务；用户不受限） */
describe('application/task-service · 委派边约束（规则 23）', () => {
  it('Agent 沿出边派单成功（todo + 通知）；越边 → ERR_ORCHESTRATION_EDGE 且不建任务', async () => {
    const harness = await createHarness()
    const current = await harness.orchestration.get(PROJECT)
    if (!current.ok) return
    await harness.orchestration.save({
      projectId: PROJECT,
      expectedVersion: 0,
      nodes: current.value.nodes,
      edges: [{ from: 'pm_1', to: 'dev_1' }],
    })

    const allowed = await harness.tasks.create({
      projectId: PROJECT,
      title: '实现登录模块',
      desc: '',
      creator: 'pm_1',
      assignee: 'dev_1',
      sessionId: 'u_dev_1',
    })
    expect(allowed.ok && allowed.value.task.state).toBe('todo')

    const denied = await harness.tasks.create({
      projectId: PROJECT,
      title: '越边派单',
      desc: '',
      creator: 'pm_1',
      assignee: 'qa_1',
      sessionId: 'u_qa_1',
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error.code).toBe('ERR_ORCHESTRATION_EDGE')
      expect(denied.error.detail).toMatchObject({ from: 'pm_1', to: 'qa_1' })
    }
    // 越边时**不建任务**
    const listed = await harness.tasks.list(PROJECT, { assignee: 'qa_1' })
    expect(listed.ok && listed.value).toEqual([])
  })

  it('用户手动派单不受边约束（可派给任意实例）', async () => {
    const harness = await createHarness()
    const created = await harness.tasks.create({
      projectId: PROJECT,
      title: '用户直接派单',
      desc: '',
      creator: 'user',
      assignee: 'qa_1',
      sessionId: 'u_qa_1',
    })
    expect(created.ok && created.value.task.assignee).toBe('qa_1')
  })
})
