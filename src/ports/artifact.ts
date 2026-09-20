import type { Result } from '../shared/result'
import type { ArtifactState, ArtifactType, FileOwnerVia } from '../shared/artifacts'
import type { InstanceId, ProjectId } from './project'
import type { SessionId } from './session'

/**
 * 产出物端口（真源：docs/design/workspaces-artifacts.md、data-storage.md §6）。
 * - `artifacts.jsonl`：manifest，**append-only**（同 id 的后续行是版本/状态变更，读取按序聚合）；
 * - `artifact-versions/<artifactId>/v<n>/`：回退内容依据（快照类=完整快照；code=补丁 + 原内容）；
 * - `file-owners.jsonl`：署名与归属（一行一文件，同 relPath 取最后一条）。
 */

export interface ArtifactFile {
  readonly relPath: string
  readonly action: 'add' | 'modify' | 'delete'
  /** 提交后的内容 sha256（delete 时为提交前内容哈希） */
  readonly hash: string
}

export interface ArtifactRecord {
  readonly id: string
  readonly type: ArtifactType
  readonly title: string
  readonly summary: string
  readonly submitter: InstanceId
  readonly state: ArtifactState
  /** 版本号：登记/聚合一次即 +1（回退也产生新版本，state=reverted） */
  readonly version: number
  readonly files: readonly ArtifactFile[]
  readonly diffSummary: { readonly add: number; readonly del: number }
  readonly prevVersion: number | null
  readonly approvalId: string | null
  /** 归属任务（无任务上下文时按回合兜底，D14-⑧） */
  readonly taskId: string | null
  readonly sessionId: SessionId
  readonly turn: number
  /** 该版本内容目录（相对 FileStore 根），如 `data/projects/<pid>/artifact-versions/<id>/v1` */
  readonly versionDir: string
  /**
   * 回退产生的新版本记录里的目标版本：`undo` 时＝被撤销的那一版，`restore` 时＝退回到的那一版。
   * 非 reverted 版本为 `null`。
   */
  readonly revertedTo: number | null
  /**
   * 回退方式（S54/D58）：`undo`＝撤销该版本的改动（恢复其 base，历史口径）；
   * `restore`＝退回到该版本的**内容**（等价于撤销它之后的所有版本）。缺省/旧数据视为 `undo`。
   */
  readonly revertMode?: ArtifactRollbackMode | null
  readonly ts: string
}

/** 回退方式：见 `ArtifactRecord.revertMode`（S54/D58） */
export type ArtifactRollbackMode = 'undo' | 'restore'

export interface ArtifactListFilter {
  readonly type?: ArtifactType
  readonly submitter?: InstanceId
  readonly state?: ArtifactState
  readonly taskId?: string
  readonly limit?: number
}

/** 版本内容条目：`snapshot`=提交后内容，`base`=提交前内容（新增文件为 null） */
export interface VersionFileEntry {
  readonly relPath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly hash: string
  readonly snapshot: string | null
  readonly base: string | null
}

export interface VersionBundle {
  readonly artifactId: string
  readonly version: number
  readonly dir: string
  readonly diffText: string
  readonly files: readonly VersionFileEntry[]
}

export interface FileOwnerRecord {
  readonly relPath: string
  readonly owner: InstanceId
  readonly ownerName: string
  readonly firstAt: string
  readonly lastAt: string
  readonly edits: number
  readonly lastTaskId: string | null
  readonly via: FileOwnerVia
}

export interface ArtifactStore {
  create(projectId: ProjectId, record: ArtifactRecord): Promise<Result<ArtifactRecord>>
  /** 追加版本/状态变更行（append-only；同 id 读取时聚合） */
  update(projectId: ProjectId, record: ArtifactRecord): Promise<Result<ArtifactRecord>>
  /** 每个 artifact 只返回最新记录 */
  list(projectId: ProjectId, filter?: ArtifactListFilter): Promise<Result<readonly ArtifactRecord[]>>
  get(projectId: ProjectId, artifactId: string): Promise<Result<ArtifactRecord>>
  /** 某 artifact 的全部版本（版本号升序） */
  versions(projectId: ProjectId, artifactId: string): Promise<Result<readonly ArtifactRecord[]>>
  putVersion(
    projectId: ProjectId,
    artifactId: string,
    version: number,
    files: readonly VersionFileEntry[],
  ): Promise<Result<{ readonly dir: string; readonly diffText: string }>>
  getVersion(projectId: ProjectId, artifactId: string, version: number): Promise<Result<VersionBundle>>
  listOwners(projectId: ProjectId, filter?: { readonly owner?: InstanceId }): Promise<Result<readonly FileOwnerRecord[]>>
  ownerOf(projectId: ProjectId, relPath: string): Promise<Result<FileOwnerRecord | null>>
  /** 首写认领 / 续写累加（同 relPath 追加新行，读取取最后一条） */
  claim(
    projectId: ProjectId,
    input: {
      readonly relPath: string
      readonly owner: InstanceId
      readonly ownerName: string
      readonly lastTaskId: string | null
      readonly via: FileOwnerVia
    },
  ): Promise<Result<FileOwnerRecord>>
  /** 追加未结算编辑（`pending/<key>.jsonl`，append-only；同 relPath 的 base 只记首次） */
  appendPending(
    projectId: ProjectId,
    key: string,
    entry: {
      readonly relPath: string
      readonly action: 'add' | 'modify' | 'delete'
      readonly base: string | null
      readonly hash: string
      readonly lastTaskId: string | null
      readonly sessionId: SessionId
      readonly turn: number
    },
  ): Promise<Result<void>>
  pendingOf(projectId: ProjectId, key: string): Promise<Result<readonly PendingEdit[]>>
  /** 落袋：把该 key 的暂存文件移入 `pending-settled/`（保留审计，不影响后续聚合） */
  settlePending(projectId: ProjectId, key: string): Promise<Result<void>>
}

/** 未结算编辑（任务级聚合的暂存记录；`pending-edits.jsonl`，append-only） */
export interface PendingEdit {
  readonly relPath: string
  readonly action: 'add' | 'modify' | 'delete'
  /** 该文件在本次聚合中的**最初**内容（首次编辑时捕获；新增文件为 null） */
  readonly base: string | null
  /** 最近一次编辑后的内容哈希 */
  readonly hash: string
  readonly lastTaskId: string | null
  readonly sessionId: SessionId
  readonly turn: number
  readonly ts: string
}

export interface ArtifactService {
  /** `workdir_edit`：归属校验 → 写入 → 署名 + 暂存未结算改动 */
  editFile(input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly relPath: string
    readonly content: string
    readonly taskId: string | null
    readonly sessionId: SessionId
    readonly turn: number
  }): Promise<Result<{ readonly action: 'add' | 'modify'; readonly hash: string; readonly diff: { readonly add: number; readonly del: number } }>>
  /** `artifact_submit`：把已写好的文件登记为产出物（快照/补丁 + manifest + 署名） */
  submit(input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly title: string
    readonly summary: string
    readonly type: ArtifactType
    /** 省略 = 登记该 key（任务/回合）的全部未结算改动 */
    readonly relPaths?: readonly string[]
    readonly taskId: string | null
    readonly sessionId: SessionId
    readonly turn: number
    readonly approvalId?: string | null
  }): Promise<Result<ArtifactRecord>>
  /** 任务级聚合落袋（任务 done / 终止前结算 / Agent 显式提交） */
  settle(input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly key: string
    readonly title: string
    readonly summary: string
    readonly type: ArtifactType
    readonly taskId: string | null
    readonly sessionId: SessionId
    readonly turn: number
  }): Promise<Result<ArtifactRecord | null>>
  /**
   * 回退（S54/D58 增加 `mode`）：
   * - `undo`（缺省，历史口径）：把目标版本涉及的 relPath 恢复为其 `base`（＝撤销这一版）；
   * - `restore`：把文件恢复成目标版本的**内容**（＝撤销它之后的所有版本）。
   * 两种方式都产生一条新版本（`state=reverted`），不物理删历史。
   */
  rollback(input: {
    readonly projectId: ProjectId
    readonly instanceId: InstanceId
    readonly artifactId: string
    readonly version: number
    /** 缺省 `undo` */
    readonly mode?: ArtifactRollbackMode
    /** force=true 时跳过"文件已被后续修改"的冲突拦截（用户明确选择覆盖） */
    readonly force?: boolean
    readonly sessionId: SessionId
    readonly turn: number
  }): Promise<Result<ArtifactRecord>>
  pending(projectId: ProjectId, key: string): Promise<Result<readonly PendingEdit[]>>
  /** 未结算改动的汇总（任务 done 后 artifact 文件清单 = 该任务全部变更，规则 12） */
  pendingSummary(
    projectId: ProjectId,
    key: string,
  ): Promise<Result<{ readonly files: number; readonly diffSummary: { readonly add: number; readonly del: number } }>>
  list(projectId: ProjectId, filter?: ArtifactListFilter): Promise<Result<readonly ArtifactRecord[]>>
  get(projectId: ProjectId, artifactId: string): Promise<Result<ArtifactRecord>>
  versions(projectId: ProjectId, artifactId: string): Promise<Result<readonly ArtifactRecord[]>>
  listOwners(projectId: ProjectId, filter?: { readonly owner?: InstanceId }): Promise<Result<readonly FileOwnerRecord[]>>
}
