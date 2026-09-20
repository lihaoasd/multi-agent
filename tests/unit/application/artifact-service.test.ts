import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createArtifactService } from '../../../src/application/artifact/artifact-service'
import { createArtifactStore } from '../../../src/infra/file-store/artifact-store'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createProjectStore } from '../../../src/infra/file-store/project-store'
import { createWorkdirFs } from '../../../src/infra/fs/workdir-fs'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createTestLogger } from '../../helpers'
import type { ProjectId, ProjectMeta, RoleInstance } from '../../../src/ports/project'
import { pendingKeyFor } from '../../../src/shared/artifacts'

const PROJECT: ProjectId = 'p_1'

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
  readonly service: ReturnType<typeof createArtifactService>
  readonly workdir: string
  readonly lock: ReturnType<typeof createKeyedLockManager>
  readonly fileStore: ReturnType<typeof createFileStore>
  readonly readWorkdir: (relPath: string) => Promise<string | null>
}

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ah-artifacts-'))
  const workdir = join(root, 'workdir')
  mkdirSync(workdir, { recursive: true })
  const fileStore = createFileStore({ root })
  const lock = createKeyedLockManager()
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  const projects = createProjectStore({ fileStore, lock, clock, dataDir: 'data' })
  const meta: ProjectMeta = {
    schemaVersion: 1,
    id: PROJECT,
    name: '产出物演示',
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
  const workdirFs = createWorkdirFs()
  return {
    workdir,
    lock,
    fileStore,
    readWorkdir: async (relPath) => {
      const snapshot = await workdirFs.read(workdir, relPath)
      return snapshot.ok ? (snapshot.value?.content ?? null) : null
    },
    service: createArtifactService({
      store: createArtifactStore({ fileStore, lock, clock, dataDir: 'data' }),
      workdir: workdirFs,
      projects,
      lock,
      ids: createIdGenerator(),
      clock,
      logger: createTestLogger(),
    }),
  }
}

const base = { projectId: PROJECT, sessionId: 'u_dev_1', turn: 1, taskId: null } as const

/** 规则 4/10/12/21：唯一写通道、归属校验、版本与回退、任务级聚合 */
describe('application/artifact-service（规则 4/10/12/21）', () => {
  it('规则 21：无主文件首写认领，他人写入 ERR_FORBIDDEN 并点名 owner', async () => {
    const harness = await createHarness()
    const first = await harness.service.editFile({
      ...base,
      instanceId: 'dev_1',
      relPath: 'src/login.ts',
      content: 'export const login = () => {}',
    })
    expect(first.ok && first.value.action).toBe('add')

    const owners = await harness.service.listOwners(PROJECT)
    expect(owners.ok && owners.value[0]).toMatchObject({ relPath: 'src/login.ts', owner: 'dev_1', ownerName: '高级开发', edits: 1 })

    const other = await harness.service.editFile({
      ...base,
      instanceId: 'qa_1',
      relPath: 'src/login.ts',
      content: '被别人改了',
    })
    expect(other.ok).toBe(false)
    if (!other.ok) {
      expect(other.error.code).toBe('ERR_FORBIDDEN')
      expect(other.error.message).toContain('高级开发')
      expect(other.error.detail?.['owner']).toBe('dev_1')
    }
    // 内容未被覆盖
    expect(await harness.readWorkdir('src/login.ts')).toContain('export const login')
  })

  it('规则 12：编辑锁命中返回 ERR_CONFLICT（不排队、不覆盖）', async () => {
    const harness = await createHarness()
    await harness.lock.tryLock(`edit:${PROJECT}:src/login.ts`, async () => {
      const blocked = await harness.service.editFile({
        ...base,
        instanceId: 'dev_1',
        relPath: 'src/login.ts',
        content: '并发写入',
      })
      expect(blocked.ok).toBe(false)
      if (!blocked.ok) expect(blocked.error.code).toBe('ERR_CONFLICT')
    })
    expect(await harness.readWorkdir('src/login.ts')).toBeNull()
  })

  it('规则 4：登记产出物写 manifest + 版本目录；同题再次登记版本递增（v2）', async () => {
    const harness = await createHarness()
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: '第一版' })
    const v1 = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: 'PRD',
      summary: '产品需求文档',
      type: 'doc',
      relPaths: ['docs/prd.md'],
    })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(v1.value).toMatchObject({ type: 'doc', version: 1, state: 'approved', prevVersion: null })
    expect(v1.value.files).toEqual([{ relPath: 'docs/prd.md', action: 'add', hash: v1.value.files[0]?.hash }])
    expect(v1.value.diffSummary).toEqual({ add: 1, del: 0 })

    const manifest = await harness.fileStore.readText(`data/projects/${PROJECT}/artifacts.jsonl`)
    expect(manifest.ok && manifest.value.trim().split('\n')).toHaveLength(1)
    expect(await harness.fileStore.exists(`${v1.value.versionDir}/manifest.json`)).toBe(true)
    expect(await harness.fileStore.exists(`${v1.value.versionDir}/diff.patch`)).toBe(true)

    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: '第一版\n第二版' })
    const v2 = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: 'PRD',
      summary: '产品需求文档',
      type: 'doc',
      relPaths: ['docs/prd.md'],
    })
    expect(v2.ok).toBe(true)
    if (!v2.ok) return
    expect(v2.value.id).toBe(v1.value.id)
    expect(v2.value).toMatchObject({ version: 2, prevVersion: 1 })

    const versions = await harness.service.versions(PROJECT, v1.value.id)
    expect(versions.ok && versions.value.map((item) => item.version)).toEqual([1, 2])
    const latest = await harness.service.list(PROJECT)
    expect(latest.ok && latest.value).toHaveLength(1)
  })

  it('规则 10：回退恢复到该版本的 base 内容；文件被后续修改过则拒绝（force 可覆盖）', async () => {
    const harness = await createHarness()
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: 'A' })
    const v1 = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: 'PRD',
      summary: '',
      type: 'doc',
      relPaths: ['docs/prd.md'],
    })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return

    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: 'B' })
    const v2 = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: 'PRD',
      summary: '',
      type: 'doc',
      relPaths: ['docs/prd.md'],
    })
    expect(v2.ok).toBe(true)
    if (!v2.ok) return
    expect(await harness.readWorkdir('docs/prd.md')).toBe('B')

    // 回退 v1：v1 是 add，回退后文件应被删除（内容与"v1 之前"一致）
    const rolledBack = await harness.service.rollback({
      ...base,
      instanceId: 'dev_1',
      artifactId: v2.value.id,
      version: 1,
    })
    expect(rolledBack.ok).toBe(true)
    if (!rolledBack.ok) return
    expect(rolledBack.value).toMatchObject({ state: 'reverted', version: 3, revertedTo: 1 })
    expect(await harness.readWorkdir('docs/prd.md')).toBeNull()

    // 外部把文件改回来（模拟后续提交/手工修改）→ 回退 v2 前必须先确认
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: 'C' })
    const conflicted = await harness.service.rollback({
      ...base,
      instanceId: 'dev_1',
      artifactId: v2.value.id,
      version: 2,
    })
    expect(conflicted.ok).toBe(false)
    if (!conflicted.ok) {
      expect(conflicted.error.code).toBe('ERR_CONFLICT')
      expect(conflicted.error.detail?.['conflicted']).toEqual(['docs/prd.md'])
    }

    const forced = await harness.service.rollback({
      ...base,
      instanceId: 'dev_1',
      artifactId: v2.value.id,
      version: 2,
      force: true,
    })
    expect(forced.ok).toBe(true)
    // v2 的 base = 'A' → 回退后工作目录内容与快照一致
    expect(await harness.readWorkdir('docs/prd.md')).toBe('A')
  })

  it('回退的冲突判定按"该文件已知最新内容"取基准：最新一版没碰这个文件时不误报冲突', async () => {
    const harness = await createHarness()
    const submit = async (relPaths: readonly string[]): Promise<string> => {
      const submitted = await harness.service.submit({
        ...base,
        instanceId: 'dev_1',
        title: 'PRD',
        summary: '',
        type: 'doc',
        relPaths,
      })
      expect(submitted.ok).toBe(true)
      if (!submitted.ok) throw new Error(submitted.error.message)
      return submitted.value.id
    }

    // v1 新增 prd；v2 改 prd；v3 只新增 ux（**没有碰 prd**）
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: 'A' })
    const artifactId = await submit(['docs/prd.md'])
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/prd.md', content: 'B' })
    await submit(['docs/prd.md'])
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/ux.md', content: 'UX' })
    await submit(['docs/ux.md'])

    // 撤销 v2 → prd 回到 v2 的 base（=A）。若拿"最新一版的文件清单"当基准，这里会被误判成冲突
    const undone = await harness.service.rollback({ ...base, instanceId: 'dev_1', artifactId, version: 2 })
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.value).toMatchObject({ state: 'reverted', version: 4, revertedTo: 2 })
    expect(await harness.readWorkdir('docs/prd.md')).toBe('A')
    // v3 新增的 ux 不受影响（撤销 v2 与它无关）
    expect(await harness.readWorkdir('docs/ux.md')).toBe('UX')

    // 平台之外的手工改动仍要被拦住（真实冲突）
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/ux.md', content: 'UX 手改' })
    const conflicted = await harness.service.rollback({ ...base, instanceId: 'dev_1', artifactId, version: 3 })
    expect(conflicted.ok).toBe(false)
    if (!conflicted.ok) {
      expect(conflicted.error.code).toBe('ERR_CONFLICT')
      expect(conflicted.error.detail?.['conflicted']).toEqual(['docs/ux.md'])
    }
    const forced = await harness.service.rollback({ ...base, instanceId: 'dev_1', artifactId, version: 3, force: true })
    expect(forced.ok).toBe(true)
    expect(await harness.readWorkdir('docs/ux.md')).toBeNull()
  })

  it('规则 12：任务级聚合落袋为 code artifact（文件清单=该任务全部变更）；无任务按回合兜底', async () => {
    const harness = await createHarness()
    const taskKey = pendingKeyFor({ taskId: 't_1', sessionId: 'u_dev_1', turn: 1 })
    await harness.service.editFile({
      projectId: PROJECT,
      instanceId: 'dev_1',
      relPath: 'src/a.ts',
      content: 'export const a = 1',
      taskId: 't_1',
      sessionId: 'u_dev_1',
      turn: 1,
    })
    await harness.service.editFile({
      projectId: PROJECT,
      instanceId: 'dev_1',
      relPath: 'src/b.ts',
      content: 'export const b = 2',
      taskId: 't_1',
      sessionId: 'u_dev_1',
      turn: 1,
    })

    const pending = await harness.service.pending(PROJECT, taskKey)
    expect(pending.ok && pending.value.map((item) => item.relPath)).toEqual(['src/a.ts', 'src/b.ts'])
    const summary = await harness.service.pendingSummary(PROJECT, taskKey)
    expect(summary.ok && summary.value).toEqual({ files: 2, diffSummary: { add: 2, del: 0 } })

    const settled = await harness.service.settle({
      projectId: PROJECT,
      instanceId: 'dev_1',
      key: taskKey,
      title: '实现登录模块',
      summary: '任务完成结算',
      type: 'code',
      taskId: 't_1',
      sessionId: 'u_dev_1',
      turn: 1,
    })
    expect(settled.ok && settled.value).not.toBeNull()
    if (!settled.ok || settled.value === null) return
    expect(settled.value.files.map((file) => file.relPath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(settled.value.taskId).toBe('t_1')
    expect(settled.value.versionDir).toContain('artifact-versions')
    // 落袋后暂存清空，不会重复结算
    const after = await harness.service.pending(PROJECT, taskKey)
    expect(after.ok && after.value).toEqual([])
    const again = await harness.service.settle({
      projectId: PROJECT,
      instanceId: 'dev_1',
      key: taskKey,
      title: '实现登录模块',
      summary: '',
      type: 'code',
      taskId: 't_1',
      sessionId: 'u_dev_1',
      turn: 1,
    })
    expect(again.ok && again.value).toBeNull()

    // 回合兜底：无任务时的 key = turn-<sessionId>-<turn>
    await harness.service.editFile({
      projectId: PROJECT,
      instanceId: 'dev_1',
      relPath: 'src/c.ts',
      content: 'export const c = 3',
      taskId: null,
      sessionId: 'u_dev_1',
      turn: 7,
    })
    const fallback = await harness.service.settle({
      projectId: PROJECT,
      instanceId: 'dev_1',
      key: pendingKeyFor({ taskId: null, sessionId: 'u_dev_1', turn: 7 }),
      title: '回合改动',
      summary: '无任务上下文的兜底结算',
      type: 'code',
      taskId: null,
      sessionId: 'u_dev_1',
      turn: 7,
    })
    expect(fallback.ok && fallback.value?.files.map((file) => file.relPath)).toEqual(['src/c.ts'])
  })

  it('回退他人提交被拒（Agent 侧），用户经接口代行（服务层以提交者身份调用）', async () => {
    const harness = await createHarness()
    await harness.service.editFile({ ...base, instanceId: 'dev_1', relPath: 'docs/x.md', content: 'x' })
    const submitted = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: 'X',
      summary: '',
      type: 'doc',
      relPaths: ['docs/x.md'],
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    const denied = await harness.service.rollback({
      ...base,
      instanceId: 'qa_1',
      artifactId: submitted.value.id,
      version: 1,
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('ERR_FORBIDDEN')
  })

  it('没有可登记改动时 submit 返回 ERR_VALIDATION 提示先写文件', async () => {
    const harness = await createHarness()
    const empty = await harness.service.submit({
      ...base,
      instanceId: 'dev_1',
      title: '空提交',
      summary: '',
      type: 'doc',
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('ERR_VALIDATION')
  })
})
