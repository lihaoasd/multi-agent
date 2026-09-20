import type { ArtifactRecord, ArtifactRollbackMode } from '../api/work'

/**
 * 产出物版本历史与回退的纯逻辑（S54/D58，可在 node 侧单测）。
 *
 * 两个概念必须分清（workspaces-artifacts.md §3、D58）：
 * - **撤销（undo）**：撤销某一版的改动（把该版文件恢复为其提交前的内容）——历史口径，Agent 的 `artifact_rollback` 用它；
 * - **退回（restore）**：把文件恢复成某一版的**内容**（等价于撤销它之后的所有版本）——用户在「版本历史」里点「退回此版本」用它。
 */

export type ArtifactVersionTone = 'green' | 'orange' | 'default'

export interface ArtifactVersionFileView {
  readonly relPath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly actionText: string
}

export interface ArtifactVersionRow {
  readonly version: number
  /** 最新一版（当前内容）；不能再"退回"到它 */
  readonly isCurrent: boolean
  readonly stateText: string
  readonly tone: ArtifactVersionTone
  readonly submitter: string
  readonly ts: string
  readonly add: number
  readonly del: number
  readonly files: readonly ArtifactVersionFileView[]
}

export function actionText(action: 'add' | 'modify' | 'delete'): string {
  if (action === 'add') return '新增'
  if (action === 'delete') return '删除'
  return '修改'
}

export function rollbackModeText(record: Pick<ArtifactRecord, 'state' | 'revertedTo' | 'revertMode'>): string {
  if (record.state !== 'reverted') {
    if (record.state === 'submitted') return '待审批'
    if (record.state === 'rejected') return '已拒绝'
    return '已登记'
  }
  const mode: ArtifactRollbackMode = record.revertMode ?? 'undo'
  return mode === 'restore' ? `已退回 v${record.revertedTo ?? '?'}` : `已撤销 v${record.revertedTo ?? '?'}`
}

export function rollbackTone(record: Pick<ArtifactRecord, 'state'>): ArtifactVersionTone {
  if (record.state === 'reverted') return 'orange'
  if (record.state === 'approved') return 'green'
  return 'default'
}

/** 服务端按版本号升序返回 → 界面按"最新在前"展示（与"退回某一版"的心智一致） */
export function versionRows(versions: readonly ArtifactRecord[]): readonly ArtifactVersionRow[] {
  const current = versions.reduce<number | null>(
    (max, item) => (max === null || item.version > max ? item.version : max),
    null,
  )
  return [...versions]
    .sort((left, right) => right.version - left.version)
    .map((item) => ({
      version: item.version,
      isCurrent: item.version === current,
      stateText: rollbackModeText(item),
      tone: rollbackTone(item),
      submitter: item.submitter,
      ts: item.ts,
      add: item.diffSummary.add,
      del: item.diffSummary.del,
      files: item.files.map((file) => ({
        relPath: file.relPath,
        action: file.action,
        actionText: actionText(file.action),
      })),
    }))
}

export interface RestorePlan {
  /** 会被写回目标版本内容的文件 */
  readonly writes: readonly string[]
  /** 目标版本之后新增、退回时会被删除的文件 */
  readonly deletes: readonly string[]
}

/**
 * 「退回此版本」的文件级预览，与服务端 `rollback({mode:'restore'})` 的算法同源：
 * 按版本号升序看目标版本**之后**的每一版，某文件**首次**被改动的那一版的 `action`
 * 决定它的归属——`add`＝那一版是新增（退回即删除它），其余＝写回该版 base（＝目标版本时的内容）。
 */
export function restorePlan(input: {
  readonly target: number
  readonly versions: readonly ArtifactRecord[]
}): RestorePlan {
  const decided = new Map<string, 'write' | 'delete'>()
  for (const item of [...input.versions].sort((left, right) => left.version - right.version)) {
    if (item.version <= input.target) continue
    for (const file of item.files) {
      if (decided.has(file.relPath)) continue
      decided.set(file.relPath, file.action === 'add' ? 'delete' : 'write')
    }
  }
  const writes: string[] = []
  const deletes: string[] = []
  for (const [relPath, kind] of decided) (kind === 'delete' ? deletes : writes).push(relPath)
  return { writes, deletes }
}

/** 回退确认文案（把"会发生什么"写清楚，避免静默覆盖） */
export function rollbackConfirmText(input: {
  readonly target: number
  readonly nextVersion: number
  readonly plan: RestorePlan
}): string {
  const parts: string[] = []
  if (input.plan.writes.length > 0) parts.push(`写回 ${input.plan.writes.length} 个文件`)
  if (input.plan.deletes.length > 0) parts.push(`删除 ${input.plan.deletes.length} 个新增文件`)
  const effect = parts.length === 0 ? '没有文件需要改动' : parts.join('、')
  return `退回后：${effect}（结果是 v${input.target} 的内容），并产生新版本 v${input.nextVersion}。历史版本不会被删除。`
}

/** `ERR_CONFLICT` 的 detail.conflicted → 文件清单（用于"仍要强制退回？"确认） */
export function conflictFiles(detail: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const raw = detail?.['conflicted']
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}
