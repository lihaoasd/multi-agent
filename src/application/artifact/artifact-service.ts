import type {
  ArtifactListFilter,
  ArtifactRecord,
  ArtifactService,
  ArtifactStore,
  FileOwnerRecord,
  PendingEdit,
} from '../../ports/artifact'
import { pendingKeyFor } from '../../shared/artifacts'
import type { Clock } from '../../ports/clock'
import type { IdGenerator } from '../../ports/id'
import type { LockManager } from '../../ports/lock'
import type { Logger } from '../../ports/logger'
import type { InstanceId, ProjectId, ProjectStore } from '../../ports/project'
import type { SessionId } from '../../ports/session'
import type { WorkdirFs } from '../../ports/workdir'
import { diffSummary } from '../../domain/rules/diff'
import { err, ok, type Result } from '../../shared/result'
import { SNAPSHOT_ARTIFACT_TYPES, type ArtifactType } from '../../shared/artifacts'

/**
 * 产出物用例（workspaces-artifacts.md §2/§3）：
 * - `editFile`：唯一写通道，**写前归属校验 + 写后署名**，并暂存未结算改动用于任务级聚合；
 * - `submit`：登记已写好的文件（版本快照/补丁 + manifest + 署名）；
 * - `settle`：任务 done / 终止前结算 / 回合兜底时把暂存改动落袋为一条 artifact；
 * - `rollback`：按版本内容依据恢复（快照类=完整快照，code=补丁的反向内容=base），新版本 state=reverted。
 *   S54/D58 起分两种方式：`undo`＝撤销目标版本这一版（恢复其 base）；`restore`＝退回到目标版本的**内容**
 *   （＝撤销它之后的所有版本，每个文件取"目标版本之后最早改动它的那一版"的 base）。
 *
 * ⚠️ 设计原文要求"code 回退=补丁反向应用"：实现里为同一版本同时保存 `diff.patch`（审计）
 * 与每个文件的 base 内容（反向应用的内容依据），回退直接写回 base（等价且不引入补丁解析风险）。
 */

export const ARTIFACT_LIMITS = {
  titleMaxChars: 120,
  summaryMaxChars: 1_000,
  filesMax: 200,
} as const

export interface ArtifactServiceOptions {
  readonly store: ArtifactStore
  readonly workdir: WorkdirFs
  readonly projects: ProjectStore
  readonly lock: LockManager
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly logger: Logger
}

const PENDING_PREVIEW_CHARS = 2_000

export function createArtifactService(options: ArtifactServiceOptions): ArtifactService {
  const { store, workdir, projects, lock, ids, clock } = options

  const projectOf = async (projectId: ProjectId): Promise<Result<{ id: ProjectId; workdir: string }>> => {
    const project = await projects.get(projectId)
    if (!project.ok) return project
    return ok({ id: project.value.id, workdir: project.value.workdir })
  }

  const displayNameOf = async (projectId: ProjectId, instanceId: InstanceId): Promise<string> => {
    const project = await projects.get(projectId)
    if (!project.ok) return instanceId
    return project.value.team.find((item) => item.instanceId === instanceId)?.displayName ?? instanceId
  }

  /** 归属校验（§2.1）：无主放行、owner=自己放行、owner=他人 ERR_FORBIDDEN 并点名 */
  const assertWritable = async (projectId: ProjectId, relPath: string, instanceId: InstanceId): Promise<Result<void>> => {
    const owner = await store.ownerOf(projectId, relPath)
    if (!owner.ok) return owner
    if (owner.value !== null && owner.value.owner !== instanceId) {
      return err('ERR_FORBIDDEN', `「${relPath}」归属于 ${owner.value.ownerName}（${owner.value.owner}），只能读不能改；请另建新文件`, {
        relPath,
        owner: owner.value.owner,
        ownerName: owner.value.ownerName,
      })
    }
    return ok(undefined)
  }

  /** 把暂存改动 + 当前工作目录内容组装成版本条目 */
  const buildEntries = async (
    root: string,
    pending: readonly PendingEdit[],
  ): Promise<Result<{ entries: readonly { relPath: string; action: 'add' | 'modify' | 'delete'; hash: string; snapshot: string | null; base: string | null }[]; diff: { add: number; del: number } }>> => {
    const entries: { relPath: string; action: 'add' | 'modify' | 'delete'; hash: string; snapshot: string | null; base: string | null }[] = []
    let add = 0
    let del = 0
    for (const edit of pending) {
      const current = await workdir.read(root, edit.relPath)
      if (!current.ok) return current
      const snapshot = current.value?.content ?? null
      const action: 'add' | 'modify' | 'delete' =
        snapshot === null ? 'delete' : edit.base === null ? 'add' : 'modify'
      const counted = diffSummary(edit.base, snapshot)
      add += counted.add
      del += counted.del
      entries.push({
        relPath: edit.relPath,
        action,
        hash: current.value?.hash ?? edit.hash,
        snapshot,
        base: edit.base,
      })
    }
    return ok({ entries, diff: { add, del } })
  }

  const createVersion = async (input: {
    projectId: ProjectId
    instanceId: InstanceId
    type: ArtifactType
    title: string
    summary: string
    taskId: string | null
    sessionId: SessionId
    turn: number
    approvalId: string | null
    key: string
    settle: boolean
  }): Promise<Result<ArtifactRecord | null>> => {
    const project = await projectOf(input.projectId)
    if (!project.ok) return project
    const pending = await store.pendingOf(input.projectId, input.key)
    if (!pending.ok) return pending
    if (pending.value.length === 0) return ok(null)
    if (pending.value.length > ARTIFACT_LIMITS.filesMax) {
      return err('ERR_VALIDATION', `单次产出物文件数过多（>${ARTIFACT_LIMITS.filesMax}）`, { files: pending.value.length })
    }

    const built = await buildEntries(project.value.workdir, pending.value)
    if (!built.ok) return built

    const ownerName = await displayNameOf(input.projectId, input.instanceId)
    const title = input.title.slice(0, ARTIFACT_LIMITS.titleMaxChars)
    // 同一提交者 + 同题 + 同任务 → 版本递增（跨回合/跨会话持续累计到同一条 artifact，D14-⑧）
    const existing = await store.list(input.projectId, { submitter: input.instanceId })
    const prior = existing.ok
      ? existing.value.find(
          (item) => item.type === input.type && item.title === title && item.taskId === input.taskId,
        )
      : undefined
    const artifactId = prior?.id ?? ids.next('a')
    const version = (prior?.version ?? 0) + 1
    const put = await store.putVersion(input.projectId, artifactId, version, built.value.entries)
    if (!put.ok) return put

    const record: ArtifactRecord = {
      id: artifactId,
      type: input.type,
      title,
      summary: input.summary.slice(0, ARTIFACT_LIMITS.summaryMaxChars),
      submitter: input.instanceId,
      state: 'approved',
      version,
      files: built.value.entries.map((entry) => ({ relPath: entry.relPath, action: entry.action, hash: entry.hash })),
      diffSummary: built.value.diff,
      prevVersion: prior?.version ?? null,
      approvalId: input.approvalId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      turn: input.turn,
      versionDir: put.value.dir,
      revertedTo: null,
      revertMode: null,
      ts: clock.now().toISOString(),
    }
    const created = prior === undefined
      ? await store.create(input.projectId, record)
      : await store.update(input.projectId, record)
    if (!created.ok) return created

    for (const entry of built.value.entries) {
      const claimed = await store.claim(input.projectId, {
        relPath: entry.relPath,
        owner: input.instanceId,
        ownerName,
        lastTaskId: input.taskId,
        via: 'artifact_submit',
      })
      if (!claimed.ok) return claimed
    }
    if (input.settle) {
      const settled = await store.settlePending(input.projectId, input.key)
      if (!settled.ok) return settled
    }
    options.logger.info('产出物已登记', {
      projectId: input.projectId,
      artifactId,
      type: input.type,
      files: record.files.length,
      state: record.state,
    })
    return ok(record)
  }

  return {
    async editFile(input) {
      const project = await projectOf(input.projectId)
      if (!project.ok) return project
      const allowed = await assertWritable(input.projectId, input.relPath, input.instanceId)
      if (!allowed.ok) return allowed
      if (input.content.length > 2 * 1024 * 1024) {
        return err('ERR_VALIDATION', '单文件内容过大（>2MB）', { relPath: input.relPath })
      }

      // 同一文件的并发编辑：编辑锁命中直接 ERR_CONFLICT（规则 12/M5），不排队
      let staged: Result<{ action: 'add' | 'modify'; hash: string; diff: { add: number; del: number } }> | null = null
      const locked = await lock.tryLock(`edit:${input.projectId}:${input.relPath}`, async () => {
        const written = await workdir.write(project.value.workdir, input.relPath, input.content)
        if (!written.ok) {
          staged = written
          return
        }
        const ownerName = await displayNameOf(input.projectId, input.instanceId)
        const claimed = await store.claim(input.projectId, {
          relPath: written.value.relPath,
          owner: input.instanceId,
          ownerName,
          lastTaskId: input.taskId,
          via: 'workdir_edit',
        })
        if (!claimed.ok) {
          staged = claimed
          return
        }
        const key = pendingKeyFor({ taskId: input.taskId, sessionId: input.sessionId, turn: input.turn })
        const appended = await store.appendPending(input.projectId, key, {
          relPath: written.value.relPath,
          action: written.value.action,
          base: written.value.before,
          hash: written.value.hash,
          lastTaskId: input.taskId,
          sessionId: input.sessionId,
          turn: input.turn,
        })
        if (!appended.ok) {
          staged = appended
          return
        }
        staged = ok({ action: written.value.action, hash: written.value.hash, diff: written.value.diff })
      })
      if (!locked.acquired) {
        return err('ERR_CONFLICT', `文件正在被编辑，请稍后重试：${input.relPath}`, { relPath: input.relPath })
      }
      if (staged === null) return err('ERR_INTERNAL', '编辑结果丢失', { relPath: input.relPath })
      return staged as Result<{ action: 'add' | 'modify'; hash: string; diff: { add: number; del: number } }>
    },

    async submit(input) {
      const project = await projectOf(input.projectId)
      if (!project.ok) return project
      if (input.title.trim().length === 0) return err('ERR_VALIDATION', '产出物标题不能为空')
      const key = pendingKeyFor({ taskId: input.taskId, sessionId: input.sessionId, turn: input.turn })

      if (input.relPaths !== undefined && input.relPaths.length > 0) {
        // 显式登记指定文件：逐个做归属校验并写入暂存（base 取该文件此前的暂存 base，缺省视为 null）
        const pending = await store.pendingOf(input.projectId, key)
        if (!pending.ok) return pending
        const known = new Map(pending.value.map((entry) => [entry.relPath, entry]))
        for (const relPath of input.relPaths.slice(0, ARTIFACT_LIMITS.filesMax)) {
          const allowed = await assertWritable(input.projectId, relPath, input.instanceId)
          if (!allowed.ok) return allowed
          const current = await workdir.read(project.value.workdir, relPath)
          if (!current.ok) return current
          if (current.value === null) {
            return err('ERR_NOT_FOUND', `文件不存在，无法登记：${relPath}`, { relPath })
          }
          if (known.has(relPath)) continue
          const staged = await store.appendPending(input.projectId, key, {
            relPath,
            action: 'modify',
            base: null,
            hash: current.value.hash,
            lastTaskId: input.taskId,
            sessionId: input.sessionId,
            turn: input.turn,
          })
          if (!staged.ok) return staged
        }
      }

      const created = await createVersion({
        projectId: input.projectId,
        instanceId: input.instanceId,
        type: input.type,
        title: input.title,
        summary: input.summary,
        taskId: input.taskId,
        sessionId: input.sessionId,
        turn: input.turn,
        approvalId: input.approvalId ?? null,
        key,
        settle: true,
      })
      if (!created.ok) return created
      if (created.value === null) {
        return err('ERR_VALIDATION', '没有可登记的改动：请先用 workdir_edit 写入文件，或显式给出 relPaths')
      }
      return ok(created.value)
    },

    async settle(input) {
      return createVersion({
        projectId: input.projectId,
        instanceId: input.instanceId,
        type: input.type,
        title: input.title,
        summary: input.summary,
        taskId: input.taskId,
        sessionId: input.sessionId,
        turn: input.turn,
        approvalId: null,
        key: input.key,
        settle: true,
      })
    },

    async rollback(input) {
      const artifact = await store.get(input.projectId, input.artifactId)
      if (!artifact.ok) return artifact
      if (artifact.value.submitter !== input.instanceId) {
        // 回退他人提交需用户批准：此处只允许提交者本人（Agent 侧）；用户经 API 由服务端代行
        return err('ERR_FORBIDDEN', '只能回退自己提交的产出物（用户可在右栏直接回退）', {
          artifactId: input.artifactId,
          submitter: artifact.value.submitter,
        })
      }
      const versions = await store.versions(input.projectId, input.artifactId)
      if (!versions.ok) return versions
      const target = versions.value.find((item) => item.version === input.version)
      if (target === undefined) {
        return err('ERR_NOT_FOUND', `产出物版本不存在：${input.artifactId} v${input.version}`, { version: input.version })
      }
      const bundle = await store.getVersion(input.projectId, input.artifactId, input.version)
      if (!bundle.ok) return bundle

      const project = await projectOf(input.projectId)
      if (!project.ok) return project

      const latest = versions.value[versions.value.length - 1]
      const mode = input.mode ?? 'undo'

      // 组装"要写回什么"的计划（relPath → 目标内容；null＝删除该文件）：
      // - undo：目标版本自己的 base（撤销这一版）
      // - restore：目标版本之后**最早改动该文件**的那一版的 base（＝该文件在目标版本时的内容）
      const plan = new Map<string, { content: string | null; hash: string }>()
      if (mode === 'restore') {
        if (latest !== undefined && latest.version === target.version) {
          return err('ERR_VALIDATION', `v${target.version} 已经是最新版本，无需退回`, { version: target.version })
        }
        for (const later of versions.value) {
          if (later.version <= target.version) continue
          const laterBundle = await store.getVersion(input.projectId, input.artifactId, later.version)
          if (!laterBundle.ok) return laterBundle
          for (const file of laterBundle.value.files) {
            if (!plan.has(file.relPath)) plan.set(file.relPath, { content: file.base, hash: file.hash })
          }
        }
        if (plan.size === 0) {
          return err('ERR_VALIDATION', `v${target.version} 之后没有可退回的改动`, { version: target.version })
        }
      } else {
        for (const file of bundle.value.files) plan.set(file.relPath, { content: file.base, hash: file.hash })
      }

      // 前置校验（§3）：计划里的文件在该版本之后被改动过 → 先提示冲突（force 可覆盖）
      // 比对基准＝"平台已知的该文件最新内容"：从最新版本往前找第一个碰到它的版本
      // （不能只看最新一版的文件清单——最新一版可能根本没碰这个文件，那是假冲突）
      const committedHashOf = (relPath: string): string | null => {
        for (let index = versions.value.length - 1; index >= 0; index -= 1) {
          const version = versions.value[index]
          const file = version?.files.find((item) => item.relPath === relPath)
          if (file !== undefined) return file.action === 'delete' ? null : file.hash
        }
        return null
      }
      if (latest !== undefined && latest.version !== target.version && input.force !== true) {
        const conflicted: string[] = []
        for (const relPath of plan.keys()) {
          const current = await workdir.hash(project.value.workdir, relPath)
          if (current !== committedHashOf(relPath)) conflicted.push(relPath)
        }
        if (conflicted.length > 0) {
          return err('ERR_CONFLICT', `以下文件在该版本后被修改过，回退会覆盖它们：${conflicted.join('、')}`, {
            conflicted,
            hint: '确认覆盖请传 force=true',
          })
        }
      }

      const restored: { relPath: string; action: 'add' | 'modify' | 'delete'; hash: string; snapshot: string | null; base: string | null }[] = []
      for (const [relPath, entry] of plan) {
        const current = await workdir.read(project.value.workdir, relPath)
        if (!current.ok) return current
        if (entry.content === null) {
          // 计划里"没有 base 的文件"＝该版本新增的 → 回退即删除（新版本记录为 delete，便于再次回退）
          if (current.value !== null) {
            const removed = await workdir.remove(project.value.workdir, relPath)
            if (!removed.ok) return removed
          }
          restored.push({
            relPath,
            action: 'delete',
            hash: entry.hash,
            snapshot: null,
            base: current.value?.content ?? null,
          })
          continue
        }
        const written = await workdir.write(project.value.workdir, relPath, entry.content)
        if (!written.ok) return written
        restored.push({
          relPath,
          action: 'modify',
          hash: written.value.hash,
          snapshot: entry.content,
          base: current.value?.content ?? null,
        })
      }

      const nextVersion = (latest?.version ?? target.version) + 1
      const dir = await store.putVersion(input.projectId, input.artifactId, nextVersion, restored)
      if (!dir.ok) return dir
      const ownerName = await displayNameOf(input.projectId, input.instanceId)
      const record: ArtifactRecord = {
        ...artifact.value,
        version: nextVersion,
        state: 'reverted',
        prevVersion: latest?.version ?? null,
        files: restored.map((entry) => ({ relPath: entry.relPath, action: entry.action, hash: entry.hash })),
        diffSummary: restored.reduce(
          (acc, entry) => {
            const counted = diffSummary(entry.base, entry.snapshot)
            return { add: acc.add + counted.add, del: acc.del + counted.del }
          },
          { add: 0, del: 0 },
        ),
        versionDir: dir.value.dir,
        revertedTo: target.version,
        revertMode: mode,
        ts: clock.now().toISOString(),
        sessionId: input.sessionId,
        turn: input.turn,
      }
      const updated = await store.update(input.projectId, record)
      if (!updated.ok) return updated
      for (const entry of restored) {
        await store.claim(input.projectId, {
          relPath: entry.relPath,
          owner: input.instanceId,
          ownerName,
          lastTaskId: artifact.value.taskId,
          via: 'workdir_edit',
        })
      }
      options.logger.info('产出物已回退', {
        projectId: input.projectId,
        artifactId: input.artifactId,
        mode,
        from: target.version,
        newVersion: nextVersion,
      })
      return ok(record)
    },

    async pending(projectId, key) {
      return store.pendingOf(projectId, key)
    },

    async pendingSummary(projectId, key) {
      const pending = await store.pendingOf(projectId, key)
      if (!pending.ok) return pending
      const project = await projectOf(projectId)
      if (!project.ok) return project
      let add = 0
      let del = 0
      for (const edit of pending.value) {
        const current = await workdir.read(project.value.workdir, edit.relPath)
        if (!current.ok) return current
        const counted = diffSummary(edit.base, current.value?.content ?? null)
        add += counted.add
        del += counted.del
      }
      return ok({ files: pending.value.length, diffSummary: { add, del } })
    },

    async list(projectId: ProjectId, filter?: ArtifactListFilter) {
      return store.list(projectId, filter)
    },

    async get(projectId: ProjectId, artifactId: string) {
      return store.get(projectId, artifactId)
    },

    async versions(projectId: ProjectId, artifactId: string) {
      return store.versions(projectId, artifactId)
    },

    async listOwners(projectId: ProjectId, filter?: { owner?: InstanceId }): Promise<Result<readonly FileOwnerRecord[]>> {
      return store.listOwners(projectId, filter)
    },
  }
}

/** 供系统提示使用：我的/他人的产出物清单（§2.2） */
export function splitOwnership(
  owners: readonly FileOwnerRecord[],
  instanceId: InstanceId,
): { readonly mine: readonly FileOwnerRecord[]; readonly others: readonly FileOwnerRecord[] } {
  return {
    mine: owners.filter((item) => item.owner === instanceId),
    others: owners.filter((item) => item.owner !== instanceId),
  }
}

/** 供前端展示：类型是否"快照类" */
export function isSnapshotType(type: ArtifactType): boolean {
  return SNAPSHOT_ARTIFACT_TYPES.includes(type)
}

export { PENDING_PREVIEW_CHARS }
