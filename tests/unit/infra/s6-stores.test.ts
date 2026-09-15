import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createArtifactStore } from '../../../src/infra/file-store/artifact-store'
import { createQuestionStore } from '../../../src/infra/file-store/question-store'
import { createTaskStore } from '../../../src/infra/file-store/task-store'
import { createFileStore } from '../../../src/infra/file-store/file-store'
import { createWorkdirFs } from '../../../src/infra/fs/workdir-fs'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'
import { createFixedClock } from '../../../src/infra/util/system-clock'
import type { ArtifactRecord } from '../../../src/ports/artifact'
import type { TaskRecord } from '../../../src/ports/task'
import type { QuestionRecord } from '../../../src/ports/question'

const PROJECT = 'p_1'

function createStores(): {
  workdir: string
  fileStore: ReturnType<typeof createFileStore>
  artifacts: ReturnType<typeof createArtifactStore>
  tasks: ReturnType<typeof createTaskStore>
  questions: ReturnType<typeof createQuestionStore>
} {
  const root = mkdtempSync(join(tmpdir(), 'ah-s6-'))
  const workdir = join(root, 'workdir')
  mkdirSync(workdir, { recursive: true })
  const fileStore = createFileStore({ root })
  const lock = createKeyedLockManager()
  const clock = createFixedClock(new Date('2026-09-15T00:00:00.000Z'))
  return {
    workdir,
    fileStore,
    artifacts: createArtifactStore({ fileStore, lock, clock, dataDir: 'data' }),
    tasks: createTaskStore({ fileStore, lock, clock, dataDir: 'data' }),
    questions: createQuestionStore({ fileStore, lock, clock, dataDir: 'data' }),
  }
}

function artifact(version: number, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'a_1',
    type: 'doc',
    title: 'PRD v1',
    summary: '',
    submitter: 'pm_1',
    state: 'approved',
    version,
    files: [{ relPath: 'docs/prd.md', action: 'add', hash: 'h1' }],
    diffSummary: { add: 1, del: 0 },
    prevVersion: version === 1 ? null : version - 1,
    approvalId: null,
    taskId: null,
    sessionId: 'u_pm_1',
    turn: 1,
    versionDir: `data/projects/${PROJECT}/artifact-versions/a_1/v${version}`,
    revertedTo: null,
    ts: `2026-09-15T00:00:0${version}.000Z`,
    ...overrides,
  }
}

/** 规则 4/10/12/21/24/25 的存储层：工作目录读写、版本目录、归属表、任务与询问 */
describe('infra · S6 存储（产出物/任务/询问）', () => {
  it('workdir-fs：写入/读取/删除 + 拒绝绝对路径与 .. 逃逸（规则 2/21 的底层）', async () => {
    const store = createStores()
    const workdir = createWorkdirFs()

    expect(await workdir.read(store.workdir, 'docs/prd.md')).toMatchObject({ ok: true, value: null })
    const written = await workdir.write(store.workdir, 'docs/prd.md', '第一版')
    expect(written.ok && written.value).toMatchObject({ action: 'add', before: null, diff: { add: 1, del: 0 } })

    const again = await workdir.write(store.workdir, 'docs/prd.md', '第一版\n第二版')
    expect(again.ok && again.value).toMatchObject({ action: 'modify', before: '第一版', diff: { add: 1, del: 0 } })

    const snapshot = await workdir.read(store.workdir, 'docs/prd.md')
    expect(snapshot.ok && snapshot.value?.content).toBe('第一版\n第二版')
    expect(await workdir.exists(store.workdir, 'docs/prd.md')).toBe(true)

    for (const bad of ['../escape.txt', 'C:/windows/system32/x.txt', '/etc/passwd']) {
      const rejected = await workdir.write(store.workdir, bad, 'x')
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) expect(rejected.error.code).toBe('ERR_FORBIDDEN_PATH')
    }

    const removed = await workdir.remove(store.workdir, 'docs/prd.md')
    expect(removed.ok && removed.value.action).toBe('delete')
    expect(await workdir.exists(store.workdir, 'docs/prd.md')).toBe(false)
  })

  it('artifact-store：manifest append-only 取最新、版本目录可回读、归属表首写认领 + 续写累加', async () => {
    const store = createStores()
    await store.artifacts.create(PROJECT, artifact(1))
    await store.artifacts.create(PROJECT, artifact(2, { state: 'reverted', revertedTo: 1 }))

    const latest = await store.artifacts.get(PROJECT, 'a_1')
    expect(latest.ok && latest.value).toMatchObject({ version: 2, state: 'reverted', revertedTo: 1 })
    const versions = await store.artifacts.versions(PROJECT, 'a_1')
    expect(versions.ok && versions.value.map((item) => item.version)).toEqual([1, 2])
    const list = await store.artifacts.list(PROJECT)
    expect(list.ok && list.value).toHaveLength(1)

    const put = await store.artifacts.putVersion(PROJECT, 'a_1', 1, [
      { relPath: 'docs/prd.md', action: 'add', hash: 'h1', snapshot: '内容 A', base: null },
    ])
    expect(put.ok && put.value.diffText).toContain('+++ b/docs/prd.md')
    const bundle = await store.artifacts.getVersion(PROJECT, 'a_1', 1)
    expect(bundle.ok && bundle.value.files[0]).toMatchObject({ relPath: 'docs/prd.md', snapshot: '内容 A', base: null })

    const first = await store.artifacts.claim(PROJECT, {
      relPath: 'docs/prd.md',
      owner: 'pm_1',
      ownerName: '产品经理',
      lastTaskId: null,
      via: 'workdir_edit',
    })
    expect(first.ok && first.value).toMatchObject({ owner: 'pm_1', ownerName: '产品经理', edits: 1 })
    const second = await store.artifacts.claim(PROJECT, {
      relPath: 'docs/prd.md',
      owner: 'pm_1',
      ownerName: '产品经理',
      lastTaskId: 't_1',
      via: 'artifact_submit',
    })
    expect(second.ok && second.value).toMatchObject({ edits: 2, via: 'artifact_submit', lastTaskId: 't_1' })
    expect(second.ok && second.value.firstAt).toBe(first.ok ? first.value.firstAt : '')

    const owners = await store.artifacts.listOwners(PROJECT, { owner: 'pm_1' })
    expect(owners.ok && owners.value).toHaveLength(1)
  })

  it('artifact-store：未结算改动按 key 聚合，base 只认首次，settle 后移档', async () => {
    const store = createStores()
    const entry = {
      relPath: 'src/login.ts',
      action: 'add' as const,
      base: null,
      hash: 'h1',
      lastTaskId: 't_1',
      sessionId: 'u_dev_1',
      turn: 1,
    }
    await store.artifacts.appendPending(PROJECT, 'task-t_1', entry)
    await store.artifacts.appendPending(PROJECT, 'task-t_1', { ...entry, base: '旧内容', hash: 'h2' })

    const pending = await store.artifacts.pendingOf(PROJECT, 'task-t_1')
    expect(pending.ok && pending.value).toHaveLength(1)
    // base 只认首次（第二次写入的 base 不覆盖，保证回退依据是"任务开始前"的内容）
    expect(pending.ok && pending.value[0]).toMatchObject({ hash: 'h2', base: null })

    await store.artifacts.settlePending(PROJECT, 'task-t_1')
    const after = await store.artifacts.pendingOf(PROJECT, 'task-t_1')
    expect(after.ok && after.value).toEqual([])
  })

  it('task-store：append-only 状态流转取最后一条（规则 15/17/24）', async () => {
    const store = createStores()
    const task: TaskRecord = {
      id: 't_1',
      title: '实现登录模块',
      desc: '按 PRD 实现',
      creator: 'user',
      assignee: 'dev_1',
      state: 'todo',
      sessionId: 'u_dev_1',
      artifactIds: [],
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      note: null,
    }
    await store.tasks.create(PROJECT, task)
    await store.tasks.update(PROJECT, { ...task, state: 'in_progress', updatedAt: '2026-09-15T01:00:00.000Z' })
    await store.tasks.update(PROJECT, {
      ...task,
      state: 'done',
      artifactIds: ['a_1'],
      updatedAt: '2026-09-15T02:00:00.000Z',
    })

    const latest = await store.tasks.get(PROJECT, 't_1')
    expect(latest.ok && latest.value).toMatchObject({ state: 'done', artifactIds: ['a_1'] })
    const list = await store.tasks.list(PROJECT, { state: 'done' })
    expect(list.ok && list.value).toHaveLength(1)
    const inProgress = await store.tasks.list(PROJECT, { state: 'in_progress' })
    expect(inProgress.ok && inProgress.value).toEqual([])
  })

  it('question-store：同一 Agent 只能有一个 pending；答复后重复答复 ERR_CONFLICT（规则 25）', async () => {
    const store = createStores()
    const question: QuestionRecord = {
      id: 'q_1',
      sessionId: 'u_dev_1',
      asker: 'dev_1',
      title: '登录方案选哪个？',
      items: [{ id: 'i_1', text: '方案', options: ['A', 'B'], required: true }],
      status: 'pending',
      answer: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      answeredAt: null,
    }
    expect((await store.questions.create(PROJECT, question)).ok).toBe(true)
    const second = await store.questions.create(PROJECT, { ...question, id: 'q_2' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('ERR_QUESTION_PENDING')
    expect(await store.questions.hasPending(PROJECT, 'dev_1')).toBe(true)
    // 其他角色不受影响
    expect((await store.questions.create(PROJECT, { ...question, id: 'q_3', asker: 'qa_1' })).ok).toBe(true)

    const answered = await store.questions.answer(PROJECT, 'q_1', [{ itemId: 'i_1', choice: 'A', text: null }])
    expect(answered.ok && answered.value.status).toBe('answered')
    expect(answered.ok && answered.value.answer?.answers[0]).toMatchObject({ itemId: 'i_1', choice: 'A' })
    // pending 跨重启语义：answered 之后不再算 pending
    expect(await store.questions.hasPending(PROJECT, 'dev_1')).toBe(false)

    const again = await store.questions.answer(PROJECT, 'q_1', [{ itemId: 'i_1', choice: 'B', text: null }])
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('ERR_CONFLICT')
  })

  it('workdir-fs：写入已存在目录内的深层文件会自动建目录', async () => {
    const store = createStores()
    writeFileSync(join(store.workdir, 'existing.txt'), 'x', 'utf8')
    const workdir = createWorkdirFs()
    const written = await workdir.write(store.workdir, 'a/b/c/file.txt', 'deep')
    expect(written.ok).toBe(true)
    expect(await workdir.exists(store.workdir, 'a/b/c/file.txt')).toBe(true)
  })
})
