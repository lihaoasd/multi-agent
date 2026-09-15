import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { BrowseResult, DirectoryBrowser, WorkdirInspection } from '../../ports/fs-browse'
import type { IdGenerator } from '../../ports/id'
import type { ProjectMeta, ProjectStore, ProjectSummary, RoleInstance } from '../../ports/project'
import type { RoleTemplate, RoleTemplateStore } from '../../ports/role-templates'
import { err, ok, type Result } from '../../shared/result'

export interface ProjectServiceOptions {
  readonly store: ProjectStore
  readonly roleTemplates: RoleTemplateStore
  readonly browser: DirectoryBrowser
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
  /** 平台数据目录的**绝对路径**：工作目录不得落在其中（避免自我嵌套与沙箱越界） */
  readonly platformDataRoot: string
}

export interface ProjectMemberInput {
  readonly roleTemplateId: string
  readonly displayName?: string
}

export interface CreateProjectInput {
  readonly name: string
  readonly description?: string
  readonly workdir: string
  /** 不传 = 全部启用的内置模板（D14-① 默认团队） */
  readonly members?: readonly ProjectMemberInput[]
}

export interface ProjectPatch {
  readonly name?: string
  readonly description?: string
}

export interface ProjectService {
  list(): Promise<Result<readonly ProjectSummary[]>>
  get(projectId: string): Promise<Result<ProjectMeta>>
  create(input: CreateProjectInput): Promise<Result<ProjectMeta>>
  updateMeta(projectId: string, patch: ProjectPatch): Promise<Result<ProjectMeta>>
  remove(projectId: string): Promise<Result<void>>
  browse(path: string | null, opts?: { readonly includeHidden?: boolean }): Promise<Result<BrowseResult>>
  inspectWorkdir(path: string): Promise<Result<WorkdirInspection>>
}

const MAX_NAME = 60
const MAX_DESCRIPTION = 500

/** 路径前缀判定（大小写不敏感 + 支持两种分隔符；Windows 盘符大小写与分隔符混用都能覆盖） */
function isInsidePath(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, '').toLowerCase()
  const normalizedPath = path.toLowerCase()
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`) ||
    normalizedPath.startsWith(`${normalizedRoot}\\`)
  )
}

/** 项目服务（prd FR-01）：创建向导校验 + 团队快照（D16-⑤） */
export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const { store, roleTemplates, browser, ids, clock, config } = options
  const platform = config.get()

  const snapshotOf = (template: RoleTemplate, capturedAt: string): RoleInstance => ({
    instanceId: `${template.roleId}_1`,
    roleTemplateId: template.roleId,
    displayName: template.name,
    prompt: null,
    model: null,
    loop: null,
    enabled: true,
    configVersion: 1,
    createdAt: capturedAt,
    snapshot: {
      roleTemplateId: template.roleId,
      templateName: template.name,
      systemPrompt: template.systemPrompt,
      defaultModel: template.defaultModel,
      defaultLoop: template.defaultLoop,
      packages: template.packages,
      tools: template.tools,
      artifactTypes: template.artifactTypes,
      defaultApprovalRules: template.defaultApprovalRules,
      capturedAt,
    },
  })

  const resolveMembers = async (
    input: CreateProjectInput,
  ): Promise<Result<readonly RoleInstance[]>> => {
    const templates = await roleTemplates.list()
    if (!templates.ok) return templates
    const capturedAt = clock.now().toISOString()

    if (input.members === undefined) {
      const defaults = templates.value.filter((template) => template.source === 'builtin' && template.enabled)
      if (defaults.length === 0) {
        return err('ERR_VALIDATION', '没有可用的内置角色模板')
      }
      return ok(defaults.map((template) => snapshotOf(template, capturedAt)))
    }

    const instances: RoleInstance[] = []
    const seen = new Set<string>()
    for (const member of input.members) {
      if (seen.has(member.roleTemplateId)) continue
      seen.add(member.roleTemplateId)
      const template = templates.value.find((item) => item.roleId === member.roleTemplateId)
      if (template === undefined) {
        return err('ERR_NOT_FOUND', `角色模板不存在：${member.roleTemplateId}`, {
          roleTemplateId: member.roleTemplateId,
        })
      }
      if (!template.enabled) {
        return err('ERR_VALIDATION', `角色模板已停用：${member.roleTemplateId}`, {
          roleTemplateId: member.roleTemplateId,
        })
      }
      const instance = snapshotOf(template, capturedAt)
      instances.push(
        member.displayName === undefined || member.displayName.trim().length === 0
          ? instance
          : { ...instance, displayName: member.displayName.trim() },
      )
    }
    if (instances.length === 0) {
      return err('ERR_VALIDATION', '至少需要选择 1 个角色')
    }
    return ok(instances)
  }

  return {
    async list(): Promise<Result<readonly ProjectSummary[]>> {
      return store.list()
    },

    async get(projectId: string): Promise<Result<ProjectMeta>> {
      return store.get(projectId)
    },

    async create(input: CreateProjectInput): Promise<Result<ProjectMeta>> {
      const name = input.name.trim()
      if (name.length === 0) return err('ERR_VALIDATION', '项目名称不能为空')
      if (name.length > MAX_NAME) return err('ERR_VALIDATION', `项目名称过长（≤ ${MAX_NAME} 字）`, { length: name.length })
      const description = (input.description ?? '').trim()
      if (description.length > MAX_DESCRIPTION) {
        return err('ERR_VALIDATION', `项目描述过长（≤ ${MAX_DESCRIPTION} 字）`, { length: description.length })
      }

      const workdirInput = input.workdir.trim()
      if (workdirInput.length === 0) return err('ERR_VALIDATION', '必须选择项目工作目录')
      const inspection = await browser.inspectWorkdir(workdirInput)
      if (!inspection.ok) return inspection
      if (!inspection.value.exists) {
        return err('ERR_VALIDATION', '工作目录不存在', { workdir: workdirInput })
      }
      if (!inspection.value.isDirectory) {
        return err('ERR_VALIDATION', '工作目录不是目录', { workdir: workdirInput })
      }
      if (!inspection.value.writable) {
        return err('ERR_VALIDATION', '工作目录不可写', { workdir: workdirInput })
      }
      if (isInsidePath(inspection.value.path, options.platformDataRoot)) {
        return err('ERR_VALIDATION', '工作目录不能位于平台数据目录内', { workdir: inspection.value.path })
      }

      const members = await resolveMembers(input)
      if (!members.ok) return members

      const now = clock.now().toISOString()
      const meta: ProjectMeta = {
        schemaVersion: 1,
        id: ids.next('p'),
        name,
        description,
        createdAt: now,
        updatedAt: now,
        workdir: inspection.value.path,
        workdirKind: inspection.value.kind,
        team: members.value,
        artifactPolicy: {
          codeSubmitApproval: platform.approval.codeSubmitApproval,
          docSubmitApproval: platform.approval.docSubmitApproval,
        },
        approvalPolicy: { highRiskCommands: platform.approval.highRiskCommands },
      }
      return store.create(meta)
    },

    async updateMeta(projectId: string, patch: ProjectPatch): Promise<Result<ProjectMeta>> {
      const name = patch.name === undefined ? undefined : patch.name.trim()
      if (name !== undefined) {
        if (name.length === 0) return err('ERR_VALIDATION', '项目名称不能为空')
        if (name.length > MAX_NAME) return err('ERR_VALIDATION', `项目名称过长（≤ ${MAX_NAME} 字）`)
      }
      const description = patch.description === undefined ? undefined : patch.description.trim()
      if (description !== undefined && description.length > MAX_DESCRIPTION) {
        return err('ERR_VALIDATION', `项目描述过长（≤ ${MAX_DESCRIPTION} 字）`)
      }
      return store.update(projectId, (meta) => {
        if (name === undefined && description === undefined) {
          return err('ERR_VALIDATION', '没有可提交的字段（仅支持 name / description）')
        }
        return ok({
          ...meta,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
        })
      })
    },

    async remove(projectId: string): Promise<Result<void>> {
      return store.remove(projectId)
    },

    async browse(path: string | null, opts?: { includeHidden?: boolean }): Promise<Result<BrowseResult>> {
      return browser.browse(path, opts)
    },

    async inspectWorkdir(path: string): Promise<Result<WorkdirInspection>> {
      return browser.inspectWorkdir(path)
    },
  }
}
