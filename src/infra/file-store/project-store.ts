import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type {
  ProjectId,
  ProjectMeta,
  ProjectStore,
  ProjectSummary,
  RoleInstance,
  RoleInstanceSnapshot,
} from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

export interface ProjectStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  /** 数据根（默认 `data`），项目落在 `<dataDir>/projects/<projectId>/` */
  readonly dataDir: RelPath
}

/** 项目创建时一并建好的 append-only 记录文件（data-storage.md §2） */
const PROJECT_LOG_FILES = [
  'tasks.jsonl',
  'questions.jsonl',
  'approvals.jsonl',
  'artifacts.jsonl',
  'file-owners.jsonl',
] as const
const PROJECT_DIRS = ['sessions', 'memories', 'artifact-versions'] as const

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseLoop(raw: unknown): { strategy: string; params: Readonly<Record<string, unknown>> } {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const params =
    typeof record['params'] === 'object' && record['params'] !== null
      ? (record['params'] as Record<string, unknown>)
      : {}
  return { strategy: asString(record['strategy'], 'direct'), params }
}

function parseSnapshot(raw: unknown): RoleInstanceSnapshot | null {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
  if (record === undefined) return null
  const roleTemplateId = asString(record['roleTemplateId'])
  if (roleTemplateId.length === 0) return null
  return {
    roleTemplateId,
    templateName: asString(record['templateName'], roleTemplateId),
    systemPrompt: asString(record['systemPrompt']),
    defaultModel: typeof record['defaultModel'] === 'string' ? record['defaultModel'] : null,
    defaultLoop: parseLoop(record['defaultLoop']),
    packages: asStringArray(record['packages']),
    tools: asStringArray(record['tools']),
    artifactTypes: asStringArray(record['artifactTypes']),
    defaultApprovalRules: asStringArray(record['defaultApprovalRules']),
    capturedAt: asString(record['capturedAt']),
  }
}

function parseInstance(raw: unknown): RoleInstance | null {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
  if (record === undefined) return null
  const instanceId = asString(record['instanceId'])
  const roleTemplateId = asString(record['roleTemplateId'])
  const snapshot = parseSnapshot(record['snapshot'])
  if (instanceId.length === 0 || roleTemplateId.length === 0 || snapshot === null) return null
  return {
    instanceId,
    roleTemplateId,
    displayName: asString(record['displayName'], snapshot.templateName),
    prompt: typeof record['prompt'] === 'string' ? record['prompt'] : null,
    model: typeof record['model'] === 'string' ? record['model'] : null,
    loop: record['loop'] === null || record['loop'] === undefined ? null : parseLoop(record['loop']),
    enabled: asBoolean(record['enabled'], true),
    configVersion: Math.max(1, Math.floor(Number(record['configVersion'] ?? 1)) || 1),
    createdAt: asString(record['createdAt']),
    snapshot,
  }
}

/** 严格解析 project.json：结构非法即 ERR_VALIDATION（由调用方决定是否降级） */
export function parseProjectMeta(raw: unknown): Result<ProjectMeta> {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
  if (record === undefined) return err('ERR_VALIDATION', 'project.json 不是对象')
  if (record['schemaVersion'] !== 1) {
    return err('ERR_VALIDATION', 'project.json schemaVersion 不受支持', { schemaVersion: record['schemaVersion'] })
  }
  const id = asString(record['id'])
  if (id.length === 0) return err('ERR_VALIDATION', 'project.json 缺少 id')
  const artifactPolicy = typeof record['artifactPolicy'] === 'object' && record['artifactPolicy'] !== null
    ? (record['artifactPolicy'] as Record<string, unknown>)
    : {}
  const approvalPolicy = typeof record['approvalPolicy'] === 'object' && record['approvalPolicy'] !== null
    ? (record['approvalPolicy'] as Record<string, unknown>)
    : {}
  const team = Array.isArray(record['team'])
    ? record['team'].map(parseInstance).filter((item): item is RoleInstance => item !== null)
    : []
  return ok({
    schemaVersion: 1,
    id,
    name: asString(record['name'], id),
    description: asString(record['description']),
    createdAt: asString(record['createdAt']),
    updatedAt: asString(record['updatedAt']),
    workdir: asString(record['workdir']),
    workdirKind: record['workdirKind'] === 'existing-repo' ? 'existing-repo' : 'empty',
    team,
    artifactPolicy: {
      codeSubmitApproval: asBoolean(artifactPolicy['codeSubmitApproval'], false),
      docSubmitApproval: asBoolean(artifactPolicy['docSubmitApproval'], true),
    },
    approvalPolicy: { highRiskCommands: asBoolean(approvalPolicy['highRiskCommands'], true) },
  })
}

/**
 * 项目存储（data-storage.md §2/§3）：
 * `project.json` 是**唯一真源**；`index.json` 只是列表投影缓存（每次 list 重建，可丢可重建）。
 * 读改写走 `LockManager`（按 projectId 串行），避免并发丢更新。
 */
export function createProjectStore(options: ProjectStoreOptions): ProjectStore {
  const { fileStore, lock, clock } = options
  const projectsRoot = `${options.dataDir}/projects`
  const indexPath = `${projectsRoot}/index.json`

  const metaPath = (id: ProjectId): RelPath => `${projectsRoot}/${id}/project.json`

  const readMeta = async (id: ProjectId): Promise<Result<ProjectMeta>> => {
    const text = await fileStore.readText(metaPath(id))
    if (!text.ok) return text.error.code === 'ERR_NOT_FOUND' ? err('ERR_NOT_FOUND', '项目不存在', { id }) : text
    try {
      return parseProjectMeta(JSON.parse(text.value))
    } catch (cause) {
      return err('ERR_VALIDATION', 'project.json 解析失败', { id, cause: String(cause) })
    }
  }

  const toSummary = (meta: ProjectMeta): ProjectSummary => ({
    id: meta.id,
    name: meta.name,
    description: meta.description,
    workdir: meta.workdir,
    workdirKind: meta.workdirKind,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    memberCount: meta.team.length,
    enabledCount: meta.team.filter((instance) => instance.enabled).length,
  })

  const rebuildIndex = async (summaries: readonly ProjectSummary[]): Promise<void> => {
    await fileStore.writeJsonAtomic(indexPath, {
      schemaVersion: 1,
      rebuiltAt: clock.now().toISOString(),
      projects: summaries,
    })
  }

  const scan = async (): Promise<Result<readonly ProjectSummary[]>> => {
    const listed = await fileStore.list(projectsRoot)
    if (!listed.ok) {
      return listed.error.code === 'ERR_NOT_FOUND' ? ok([]) : listed
    }
    const summaries: ProjectSummary[] = []
    for (const entry of listed.value) {
      if (!entry.isDirectory) continue
      const meta = await readMeta(entry.name)
      if (meta.ok) summaries.push(toSummary(meta.value))
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return ok(summaries)
  }

  return {
    async list(): Promise<Result<readonly ProjectSummary[]>> {
      const summaries = await scan()
      if (!summaries.ok) return summaries
      await rebuildIndex(summaries.value)
      return summaries
    },

    async get(id: ProjectId): Promise<Result<ProjectMeta>> {
      return readMeta(id)
    },

    async create(meta: ProjectMeta): Promise<Result<ProjectMeta>> {
      return lock.withLock(`project:${meta.id}`, async () => {
        if (await fileStore.exists(metaPath(meta.id))) {
          return err('ERR_CONFLICT', '项目 id 已存在', { id: meta.id })
        }
        const projectDir = `${projectsRoot}/${meta.id}`
        for (const dir of PROJECT_DIRS) {
          const created = await fileStore.ensureDir(`${projectDir}/${dir}`)
          if (!created.ok) return created
        }
        for (const file of PROJECT_LOG_FILES) {
          const appended = await fileStore.writeTextAtomic(`${projectDir}/${file}`, '')
          if (!appended.ok) return appended
        }
        const written = await fileStore.writeJsonAtomic(metaPath(meta.id), meta)
        if (!written.ok) return written
        const summaries = await scan()
        if (summaries.ok) await rebuildIndex(summaries.value)
        return ok(meta)
      })
    },

    async update(
      id: ProjectId,
      mutate: (meta: ProjectMeta) => Result<ProjectMeta>,
    ): Promise<Result<ProjectMeta>> {
      return lock.withLock(`project:${id}`, async () => {
        const current = await readMeta(id)
        if (!current.ok) return current
        const next = mutate(current.value)
        if (!next.ok) return next
        const stamped: ProjectMeta = { ...next.value, updatedAt: clock.now().toISOString() }
        const written = await fileStore.writeJsonAtomic(metaPath(id), stamped)
        if (!written.ok) return written
        const summaries = await scan()
        if (summaries.ok) await rebuildIndex(summaries.value)
        return ok(stamped)
      })
    },

    async remove(id: ProjectId): Promise<Result<void>> {
      return lock.withLock(`project:${id}`, async () => {
        const current = await readMeta(id)
        if (!current.ok) return current
        const removed = await fileStore.remove(`${projectsRoot}/${id}`)
        if (!removed.ok) return removed
        const summaries = await scan()
        if (summaries.ok) await rebuildIndex(summaries.value)
        return ok(undefined)
      })
    },
  }
}
