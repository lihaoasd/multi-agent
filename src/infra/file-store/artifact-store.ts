import type {
  ArtifactListFilter,
  ArtifactRecord,
  ArtifactStore,
  FileOwnerRecord,
  PendingEdit,
  VersionBundle,
  VersionFileEntry,
} from '../../ports/artifact'
import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { InstanceId, ProjectId } from '../../ports/project'
import { ARTIFACT_STATES, ARTIFACT_TYPES, FILE_OWNER_VIA } from '../../shared/artifacts'
import { unifiedDiff } from '../../domain/rules/diff'
import { err, ok, type Result } from '../../shared/result'

export interface ArtifactStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

const SCHEMA_VERSION = 1

function parseArtifact(raw: unknown): ArtifactRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id.length === 0) return null
  const files: ArtifactRecord['files'] = Array.isArray(record['files'])
    ? record['files']
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null
          const file = item as Record<string, unknown>
          const relPath = typeof file['relPath'] === 'string' ? file['relPath'] : ''
          if (relPath.length === 0) return null
          const action = file['action']
          return {
            relPath,
            action: action === 'add' || action === 'delete' ? action : ('modify' as const),
            hash: typeof file['hash'] === 'string' ? file['hash'] : '',
          }
        })
        .filter((item): item is ArtifactRecord['files'][number] => item !== null)
    : []
  const diff = record['diffSummary']
  const diffSummaryValue =
    typeof diff === 'object' && diff !== null
      ? {
          add: Number((diff as Record<string, unknown>)['add'] ?? 0) || 0,
          del: Number((diff as Record<string, unknown>)['del'] ?? 0) || 0,
        }
      : { add: 0, del: 0 }
  const type = record['type']
  const state = record['state']
  return {
    id,
    type: (ARTIFACT_TYPES as readonly string[]).includes(type as string) ? (type as ArtifactRecord['type']) : 'doc',
    title: typeof record['title'] === 'string' ? record['title'] : '',
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    submitter: typeof record['submitter'] === 'string' ? record['submitter'] : '',
    state: (ARTIFACT_STATES as readonly string[]).includes(state as string)
      ? (state as ArtifactRecord['state'])
      : 'approved',
    version: Number(record['version'] ?? 1) || 1,
    files,
    diffSummary: diffSummaryValue,
    prevVersion: typeof record['prevVersion'] === 'number' ? record['prevVersion'] : null,
    approvalId: typeof record['approvalId'] === 'string' ? record['approvalId'] : null,
    taskId: typeof record['taskId'] === 'string' ? record['taskId'] : null,
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    turn: Number(record['turn'] ?? 0) || 0,
    versionDir: typeof record['versionDir'] === 'string' ? record['versionDir'] : '',
    revertedTo: typeof record['revertedTo'] === 'number' ? record['revertedTo'] : null,
    ts: typeof record['ts'] === 'string' ? record['ts'] : '',
  }
}

function parseOwner(raw: unknown): FileOwnerRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const relPath = typeof record['relPath'] === 'string' ? record['relPath'] : ''
  const owner = typeof record['owner'] === 'string' ? record['owner'] : ''
  if (relPath.length === 0 || owner.length === 0) return null
  const via = record['via']
  return {
    relPath,
    owner,
    ownerName: typeof record['ownerName'] === 'string' ? record['ownerName'] : owner,
    firstAt: typeof record['firstAt'] === 'string' ? record['firstAt'] : '',
    lastAt: typeof record['lastAt'] === 'string' ? record['lastAt'] : '',
    edits: Number(record['edits'] ?? 1) || 1,
    lastTaskId: typeof record['lastTaskId'] === 'string' ? record['lastTaskId'] : null,
    via: (FILE_OWNER_VIA as readonly string[]).includes(via as string) ? (via as FileOwnerRecord['via']) : 'workdir_edit',
  }
}

/** 文件名扁平化（版本目录内按序号存放，避免 relPath 影响目录结构） */
function flatten(relPath: string): string {
  return relPath.replace(/[\\/]/g, '__').replace(/[^0-9A-Za-z._\u4e00-\u9fff-]/g, '_')
}

/** 聚合键（taskId / 回合）扁平化为文件名 */
function safeKey(key: string): string {
  return key.replace(/[^0-9A-Za-z._-]/g, '_')
}

/** 产出物存储（workspaces-artifacts.md §2/§3、data-storage.md §6） */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  const { fileStore, lock } = options
  const projectDir = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}`
  const manifestPath = (projectId: ProjectId): RelPath => `${projectDir(projectId)}/artifacts.jsonl`
  const ownerPath = (projectId: ProjectId): RelPath => `${projectDir(projectId)}/file-owners.jsonl`
  const versionDir = (projectId: ProjectId, artifactId: string, version: number): RelPath =>
    `${projectDir(projectId)}/artifact-versions/${artifactId}/v${version}`
  const pendingPath = (projectId: ProjectId, key: string): RelPath =>
    `${projectDir(projectId)}/pending/${safeKey(key)}.jsonl`

  const readRecords = async (projectId: ProjectId): Promise<readonly ArtifactRecord[]> => {
    const text = await fileStore.readText(manifestPath(projectId))
    if (!text.ok) return []
    const records: ArtifactRecord[] = []
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseArtifact(JSON.parse(trimmed))
        if (parsed !== null) records.push(parsed)
      } catch {
        // 坏行跳过
      }
    }
    return records
  }

  const readOwners = async (projectId: ProjectId): Promise<readonly FileOwnerRecord[]> => {
    const text = await fileStore.readText(ownerPath(projectId))
    if (!text.ok) return []
    const merged = new Map<string, FileOwnerRecord>()
    for (const line of text.value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = parseOwner(JSON.parse(trimmed))
        if (parsed !== null) merged.set(parsed.relPath, parsed)
      } catch {
        // 坏行跳过
      }
    }
    return [...merged.values()]
  }

  return {
    async create(projectId, record) {
      return lock.withLock(`artifacts:${projectId}`, async () => {
        const appended = await fileStore.appendLine(manifestPath(projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async update(projectId, record) {
      return lock.withLock(`artifacts:${projectId}`, async () => {
        const appended = await fileStore.appendLine(manifestPath(projectId), JSON.stringify(record))
        return appended.ok ? ok(record) : appended
      })
    },

    async list(projectId, filter?: ArtifactListFilter) {
      const records = await readRecords(projectId)
      const latest = new Map<string, ArtifactRecord>()
      for (const record of records) latest.set(record.id, record)
      let list = [...latest.values()]
      if (filter?.type !== undefined) list = list.filter((item) => item.type === filter.type)
      if (filter?.submitter !== undefined) list = list.filter((item) => item.submitter === filter.submitter)
      if (filter?.state !== undefined) list = list.filter((item) => item.state === filter.state)
      if (filter?.taskId !== undefined) list = list.filter((item) => item.taskId === filter.taskId)
      list.sort((a, b) => b.ts.localeCompare(a.ts))
      return ok(filter?.limit === undefined ? list : list.slice(0, filter.limit))
    },

    async get(projectId, artifactId) {
      const records = (await readRecords(projectId)).filter((item) => item.id === artifactId)
      const latest = records[records.length - 1]
      return latest === undefined
        ? err('ERR_NOT_FOUND', `产出物不存在：${artifactId}`, { artifactId })
        : ok(latest)
    },

    async versions(projectId, artifactId) {
      const records = (await readRecords(projectId)).filter((item) => item.id === artifactId)
      records.sort((a, b) => a.version - b.version)
      return records.length === 0
        ? err('ERR_NOT_FOUND', `产出物不存在：${artifactId}`, { artifactId })
        : ok(records)
    },

    async putVersion(projectId, artifactId, version, files: readonly VersionFileEntry[]) {
      const dir = versionDir(projectId, artifactId, version)
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        artifactId,
        version,
        ts: options.clock.now().toISOString(),
        files: files.map((file, index) => ({
          relPath: file.relPath,
          action: file.action,
          hash: file.hash,
          snapshot: file.snapshot === null ? null : `files/${index}/${flatten(file.relPath)}`,
          base: file.base === null ? null : `base/${index}/${flatten(file.relPath)}`,
        })),
      }
      const diffText = files
        .map((file) => unifiedDiff({ relPath: file.relPath, before: file.base, after: file.snapshot }))
        .join('\n')

      return lock.withLock(`artifacts:${projectId}`, async (): Promise<Result<{ dir: string; diffText: string }>> => {
        for (const [index, file] of files.entries()) {
          if (file.snapshot !== null) {
            const written = await fileStore.writeTextAtomic(`${dir}/files/${index}/${flatten(file.relPath)}`, file.snapshot)
            if (!written.ok) return written
          }
          if (file.base !== null) {
            const written = await fileStore.writeTextAtomic(`${dir}/base/${index}/${flatten(file.relPath)}`, file.base)
            if (!written.ok) return written
          }
        }
        const meta = await fileStore.writeJsonAtomic(`${dir}/manifest.json`, { ...manifest, diffText })
        if (!meta.ok) return meta
        const patch = await fileStore.writeTextAtomic(`${dir}/diff.patch`, diffText)
        if (!patch.ok) return patch
        return ok({ dir, diffText })
      })
    },

    async getVersion(projectId, artifactId, version) {
      const dir = versionDir(projectId, artifactId, version)
      const manifest = await fileStore.readJson<{
        files?: readonly { relPath: string; action: 'add' | 'modify' | 'delete'; hash: string; snapshot: string | null; base: string | null }[]
        diffText?: string
      }>(`${dir}/manifest.json`)
      if (!manifest.ok) {
        return err('ERR_NOT_FOUND', `产出物版本不存在：${artifactId} v${version}`, { artifactId, version })
      }
      const readMaybe = async (path: string | null): Promise<string | null> => {
        if (path === null) return null
        const text = await fileStore.readText(`${dir}/${path}`)
        return text.ok ? text.value : null
      }
      const files: VersionFileEntry[] = []
      for (const entry of manifest.value.files ?? []) {
        files.push({
          relPath: entry.relPath,
          action: entry.action,
          hash: entry.hash,
          snapshot: await readMaybe(entry.snapshot),
          base: await readMaybe(entry.base),
        })
      }
      const bundle: VersionBundle = {
        artifactId,
        version,
        dir,
        diffText: manifest.value.diffText ?? '',
        files,
      }
      return ok(bundle)
    },

    async listOwners(projectId, filter?: { owner?: InstanceId }) {
      let owners = [...(await readOwners(projectId))]
      if (filter?.owner !== undefined) owners = owners.filter((item) => item.owner === filter.owner)
      owners.sort((a, b) => a.relPath.localeCompare(b.relPath))
      return ok(owners)
    },

    async ownerOf(projectId, relPath) {
      const found = (await readOwners(projectId)).find((item) => item.relPath === relPath)
      return ok(found ?? null)
    },

    async claim(projectId, input) {
      return lock.withLock(`artifacts:${projectId}`, async () => {
        const current = (await readOwners(projectId)).find((item) => item.relPath === input.relPath)
        const nowIso = options.clock.now().toISOString()
        const next: FileOwnerRecord = {
          relPath: input.relPath,
          owner: input.owner,
          ownerName: input.ownerName,
          firstAt: current?.firstAt ?? nowIso,
          lastAt: nowIso,
          edits: (current?.edits ?? 0) + 1,
          lastTaskId: input.lastTaskId,
          via: input.via,
        }
        const appended = await fileStore.appendLine(ownerPath(projectId), JSON.stringify(next))
        return appended.ok ? ok(next) : appended
      })
    },

    async appendPending(projectId, key, entry) {
      const appended = await fileStore.appendLine(
        pendingPath(projectId, key),
        JSON.stringify({
          relPath: entry.relPath,
          action: entry.action,
          base: entry.base,
          hash: entry.hash,
          lastTaskId: entry.lastTaskId,
          sessionId: entry.sessionId,
          turn: entry.turn,
          ts: options.clock.now().toISOString(),
        }),
      )
      return appended.ok ? ok(undefined) : appended
    },

    async pendingOf(projectId, key) {
      const text = await fileStore.readText(pendingPath(projectId, key))
      if (!text.ok) return ok([])
      const byPath = new Map<string, PendingEdit>()
      for (const line of text.value.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const parsed = JSON.parse(trimmed) as PendingEdit
          if (typeof parsed.relPath !== 'string' || parsed.relPath.length === 0) continue
          const current = byPath.get(parsed.relPath)
          byPath.set(parsed.relPath, {
            ...parsed,
            // base 只认首次捕获（回退与原内容依据）
            base: current === undefined ? parsed.base : current.base,
          })
        } catch {
          // 坏行跳过
        }
      }
      return ok([...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)))
    },

    async settlePending(projectId, key) {
      const from = pendingPath(projectId, key)
      const exists = await fileStore.exists(from)
      if (!exists) return ok(undefined)
      const moved = await fileStore.move(from, `${projectDir(projectId)}/pending-settled/${safeKey(key)}-${Date.now()}.jsonl`)
      return moved.ok ? ok(undefined) : moved
    },
  }
}
