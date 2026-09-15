import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type {
  LoopConfig,
  RoleTemplate,
  RoleTemplateCreateInput,
  RoleTemplatePatch,
  RoleTemplateStore,
} from '../../ports/role-templates'
import { BASE_TOOL_PACKAGES } from '../../shared/loop'
import { err, ok, type Result } from '../../shared/result'

export interface RoleTemplateStoreOptions {
  readonly fileStore: FileStore
  /** 角色模板目录：数据根下的那份视为**用户模板**（可写），其余为**内置模板**（只读） */
  readonly roleDirs: readonly RelPath[]
  readonly dataDir: RelPath
  readonly clock: Clock
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseLoop(value: unknown): LoopConfig {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const params = typeof record['params'] === 'object' && record['params'] !== null
    ? (record['params'] as Record<string, unknown>)
    : {}
  return { strategy: asString(record['strategy'], 'direct'), params }
}

export function parseRoleTemplate(raw: unknown): RoleTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const roleId = asString(record['roleId'])
  if (roleId.length === 0) return null
  const packages = asStringArray(record['packages'])
  return {
    roleId,
    name: asString(record['name'], roleId),
    category: asString(record['category'], 'general'),
    scenario: asString(record['scenario'], 'software'),
    description: asString(record['description']),
    systemPrompt: asString(record['systemPrompt']),
    defaultModel: typeof record['defaultModel'] === 'string' ? record['defaultModel'] : null,
    defaultLoop: parseLoop(record['defaultLoop']),
    packages: packages.length > 0 ? packages : [...BASE_TOOL_PACKAGES],
    tools: asStringArray(record['tools']),
    artifactTypes: asStringArray(record['artifactTypes']),
    defaultApprovalRules: asStringArray(record['defaultApprovalRules']),
    source: 'builtin',
    enabled: record['enabled'] !== false,
    ...(typeof record['copyFrom'] === 'string' ? { copyFrom: record['copyFrom'] } : {}),
  }
}

function serialize(template: RoleTemplate): string {
  return stringifyYaml({
    roleId: template.roleId,
    name: template.name,
    category: template.category,
    scenario: template.scenario,
    description: template.description,
    systemPrompt: template.systemPrompt,
    defaultModel: template.defaultModel,
    defaultLoop: { strategy: template.defaultLoop.strategy, params: template.defaultLoop.params },
    packages: [...template.packages],
    tools: [...template.tools],
    artifactTypes: [...template.artifactTypes],
    defaultApprovalRules: [...template.defaultApprovalRules],
    enabled: template.enabled,
    ...(template.copyFrom === undefined ? {} : { copyFrom: template.copyFrom }),
  })
}

function withoutYamlExtension(name: string): string {
  return name.replace(/\.ya?ml$/i, '')
}

/**
 * 角色模板存储（data-storage.md §8）：
 * 内置目录只读、用户目录可写；**不存在"同名文件覆盖内置"**路径（D16-⑤ 要求复制新建用新 roleId）。
 */
export function createRoleTemplateStore(options: RoleTemplateStoreOptions): RoleTemplateStore {
  const { fileStore, clock } = options
  const userDir = options.roleDirs.find((dir) => dir.startsWith(`${options.dataDir}/`)) ?? `${options.dataDir}/roles`
  const builtinDirs = options.roleDirs.filter((dir) => dir !== userDir)

  const readDir = async (dir: RelPath, source: 'builtin' | 'user'): Promise<RoleTemplate[]> => {
    const listed = await fileStore.list(dir)
    if (!listed.ok) return []
    const templates: RoleTemplate[] = []
    for (const entry of listed.value) {
      if (entry.isDirectory || !/\.ya?ml$/i.test(entry.name)) continue
      const text = await fileStore.readText(`${dir}/${entry.name}`)
      if (!text.ok) continue
      try {
        const parsed = parseRoleTemplate(parseYaml(text.value))
        if (parsed !== null) {
          templates.push({ ...parsed, roleId: parsed.roleId || withoutYamlExtension(entry.name), source })
        }
      } catch {
        // 坏模板跳过：不让单个文件毁掉整个模板库
      }
    }
    return templates
  }

  const loadAll = async (): Promise<readonly RoleTemplate[]> => {
    const builtin = (await Promise.all(builtinDirs.map((dir) => readDir(dir, 'builtin')))).flat()
    const user = await readDir(userDir, 'user')
    const merged = new Map<string, RoleTemplate>()
    for (const template of builtin) merged.set(template.roleId, template)
    // 用户模板优先（同名视为用户显式接管；UI 只允许用新 roleId 复制，故属异常配置）
    for (const template of user) merged.set(template.roleId, template)
    return [...merged.values()]
  }

  const pathOf = (roleId: string): RelPath => `${userDir}/${roleId}.yaml`

  const write = async (template: RoleTemplate): Promise<Result<RoleTemplate>> => {
    const receipt = await fileStore.writeTextAtomic(pathOf(template.roleId), serialize(template))
    return receipt.ok ? ok(template) : receipt
  }

  const appendHistory = async (roleId: string, template: RoleTemplate): Promise<Result<string>> => {
    const stamp = clock.now().toISOString().replace(/[:.]/g, '-')
    const path = `${userDir}/${roleId}.history/${stamp}.yaml`
    const receipt = await fileStore.writeTextAtomic(path, serialize(template))
    return receipt.ok ? ok(path) : receipt
  }

  return {
    async list(): Promise<Result<readonly RoleTemplate[]>> {
      return ok(await loadAll())
    },

    async get(roleId: string): Promise<Result<RoleTemplate>> {
      const all = await loadAll()
      const found = all.find((template) => template.roleId === roleId)
      return found === undefined ? err('ERR_NOT_FOUND', `角色模板不存在：${roleId}`, { roleId }) : ok(found)
    },

    async create(input: RoleTemplateCreateInput): Promise<Result<RoleTemplate>> {
      const all = await loadAll()
      if (all.some((template) => template.roleId === input.roleId)) {
        return err('ERR_CONFLICT', `角色模板 id 已存在：${input.roleId}`, { roleId: input.roleId })
      }
      const base = all.find((template) => template.roleId === input.copyFrom)
      if (base === undefined) {
        return err('ERR_NOT_FOUND', `复制来源模板不存在：${input.copyFrom}`, { copyFrom: input.copyFrom })
      }
      const created: RoleTemplate = {
        ...base,
        roleId: input.roleId,
        name: input.name ?? `${base.name}（副本）`,
        scenario: input.scenario ?? base.scenario,
        systemPrompt: input.systemPrompt ?? base.systemPrompt,
        defaultModel: input.defaultModel === undefined ? base.defaultModel : input.defaultModel,
        defaultLoop: input.defaultLoop ?? base.defaultLoop,
        source: 'user',
        enabled: true,
        copyFrom: input.copyFrom,
      }
      const written = await write(created)
      if (!written.ok) return written
      await appendHistory(created.roleId, created)
      return ok(created)
    },

    async update(roleId: string, patch: RoleTemplatePatch): Promise<Result<RoleTemplate>> {
      const all = await loadAll()
      const existing = all.find((template) => template.roleId === roleId)
      if (existing === undefined) {
        return err('ERR_NOT_FOUND', `角色模板不存在：${roleId}`, { roleId })
      }
      if (existing.source === 'builtin') {
        return err('ERR_FORBIDDEN', '内置模板不可修改；请基于内置复制新建', { roleId })
      }
      const updated: RoleTemplate = {
        ...existing,
        systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
        defaultLoop: patch.defaultLoop ?? existing.defaultLoop,
        defaultModel: patch.defaultModel === undefined ? existing.defaultModel : patch.defaultModel,
      }
      const written = await write(updated)
      if (!written.ok) return written
      await appendHistory(roleId, updated)
      return ok(updated)
    },

    async setEnabled(roleId: string, enabled: boolean): Promise<Result<RoleTemplate>> {
      const all = await loadAll()
      const existing = all.find((template) => template.roleId === roleId)
      if (existing === undefined) {
        return err('ERR_NOT_FOUND', `角色模板不存在：${roleId}`, { roleId })
      }
      if (existing.source === 'builtin') {
        return err('ERR_FORBIDDEN', '内置模板不可停用；请基于内置复制新建', { roleId })
      }
      const updated: RoleTemplate = { ...existing, enabled }
      const written = await write(updated)
      if (!written.ok) return written
      await appendHistory(roleId, updated)
      return ok(updated)
    },

    appendHistory,

    async listHistory(roleId: string): Promise<readonly string[]> {
      const listed = await fileStore.list(`${userDir}/${roleId}.history`)
      if (!listed.ok) return []
      return listed.value.filter((entry) => !entry.isDirectory).map((entry) => entry.name).sort()
    },
  }
}
