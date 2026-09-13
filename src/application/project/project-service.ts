/**
 * 项目应用服务：项目 CRUD（M0 纯数据版）。
 * 运行时位置：dataDir/projects/<projectId>/（data-storage.md §2）；本阶段仅落 project.json，
 * workspaces/sessions 等由 M1 创建。绝不触碰用户工作目录。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso, genId } from '../../shared/util/id.js'
import { dirExists } from '../../infra/file-store/fs-utils.js'
import type { ProjectStore } from '../../infra/store/project-store.js'
import type { ProjectConfig } from '../../shared/types/project.js'
import { buildUserSessionMeta } from '../session/session-store.js'

export interface CreateProjectInput {
  name: string
  description?: string
  /** 用户选定工作目录（绝对路径；必须为已存在目录） */
  workdir: string
}

export interface PatchProjectInput {
  name?: string
  description?: string
}

/** 项目详情 DTO（HTTP 返回，不带内部字段以外的敏感信息）。 */
export type ProjectDto = ProjectConfig

const PROJECT_ID_PREFIX = 'p_'
const RUNTIME_VERSION = 1

export class ProjectService {
  constructor(
    private readonly store: ProjectStore,
    private readonly projectDefaults: {
      artifactPolicy: ProjectConfig['artifactPolicy']
      approvalPolicy: ProjectConfig['approvalPolicy']
    },
  ) {}

  /** 读 project.json（不存在 → null）。 */
  private async readProject(projectId: string): Promise<ProjectDto | null> {
    return this.store.readJson<ProjectDto>(projectId, 'project.json')
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    const name = input.name.trim()
    if (!name) throw new AppError(ErrorCodes.VALIDATION, '项目名称不能为空')
    if (name.length > 120) throw new AppError(ErrorCodes.VALIDATION, '项目名称过长（≤120 字符）')
    if (input.description !== undefined && input.description.length > 2000) {
      throw new AppError(ErrorCodes.VALIDATION, '项目描述过长（≤2000 字符）')
    }
    const workdir = input.workdir.trim()
    if (!(await dirExists(workdir))) {
      throw new AppError(ErrorCodes.VALIDATION, `工作目录不存在或不是目录: ${workdir}`)
    }

    const id = genId(PROJECT_ID_PREFIX)
    const ts = nowIso()
    const project: ProjectConfig = {
      schemaVersion: RUNTIME_VERSION,
      id,
      name,
      description: input.description?.trim() ?? '',
      createdAt: ts,
      updatedAt: ts,
      workdir,
      workdirKind: await detectWorkdirKind(workdir),
      team: [],
      artifactPolicy: { ...this.projectDefaults.artifactPolicy },
      approvalPolicy: { ...this.projectDefaults.approvalPolicy },
    }

    await this.store.writeJson(id, 'project.json', project)
    return project
  }

  async list(): Promise<ProjectDto[]> {
    const dtos: ProjectDto[] = []
    for (const name of await this.store.list('')) {
      if (!name.startsWith(PROJECT_ID_PREFIX)) continue
      const dto = await this.readProject(name)
      if (dto && dto.id === name) dtos.push(dto)
    }
    return dtos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async get(projectId: string): Promise<ProjectDto> {
    const dto = await this.tryGet(projectId)
    if (!dto) throw new AppError(ErrorCodes.NOT_FOUND, `项目不存在: ${projectId}`)
    return dto
  }

  private async tryGet(projectId: string): Promise<ProjectDto | null> {
    if (!projectId.startsWith(PROJECT_ID_PREFIX)) return null
    return this.readProject(projectId)
  }

  async patch(projectId: string, input: PatchProjectInput): Promise<ProjectDto> {
    const dto = await this.get(projectId)
    const next: ProjectConfig = { ...dto }
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new AppError(ErrorCodes.VALIDATION, '项目名称不能为空')
      if (name.length > 120) throw new AppError(ErrorCodes.VALIDATION, '项目名称过长（≤120 字符）')
      next.name = name
    }
    if (input.description !== undefined) {
      if (input.description.length > 2000) {
        throw new AppError(ErrorCodes.VALIDATION, '项目描述过长（≤2000 字符）')
      }
      next.description = input.description.trim()
    }
    next.updatedAt = nowIso()
    await this.store.writeJson(projectId, 'project.json', next)
    return next
  }

  /** 删除仅运行时项目文件夹（data/projects/<pid>）；不影响用户工作目录。 */
  async remove(projectId: string): Promise<void> {
    const dto = await this.get(projectId)
    void dto // M0 无运行中状态需要拦截；M1+ 按 architecture §7 增加占用校验
    await this.store.removeDir(projectId)
  }

  // ---- 团队（实例）管理：team 数组是 project.json 的一部分，所有写经本项目服务串行落盘 ----

  /** 读团队：按项目内顺序返回实例列表。 */
  async listTeam(projectId: string): Promise<ProjectConfig['team']> {
    const dto = await this.get(projectId)
    return dto.team
  }

  /** 追加实例（调用方需先做模板快照与唯一性校验）。写入并同步建实例运行时目录。 */
  async addMember(
    projectId: string,
    member: ProjectConfig['team'][number],
  ): Promise<ProjectConfig['team'][number]> {
    const dto = await this.get(projectId)
    const dup = dto.team.some((m) => m.instanceId === member.instanceId)
    if (dup) throw new AppError(ErrorCodes.CONFLICT, `实例已存在: ${member.instanceId}`)
    const next: ProjectConfig = { ...dto, team: [...dto.team, member], updatedAt: nowIso() }
    await this.store.writeJson(projectId, 'project.json', next)
    // 实例运行时目录骨架：workspaces/<iid>/ 与 sessions/（M1；log 由会话服务写入）
    await this.store.ensureDir(projectId, `workspaces/${member.instanceId}`)
    await this.store.ensureDir(projectId, 'sessions')
    await this.ensureUserSessionMeta(projectId, member.instanceId, member.displayName)
    return member
  }

  /** 更新实例（改名/提示词/模型/loop/tools/enabled）。roleTemplateId 不可改。 */
  async patchMember(
    projectId: string,
    instanceId: string,
    patch: Partial<
      Pick<
        ProjectConfig['team'][number],
        'displayName' | 'prompt' | 'model' | 'loop' | 'tools' | 'enabled'
      >
    >,
  ): Promise<ProjectConfig['team'][number]> {
    const dto = await this.get(projectId)
    const idx = dto.team.findIndex((m) => m.instanceId === instanceId)
    if (idx < 0) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${instanceId}`)
    const member = dto.team[idx]!
    const merged: ProjectConfig['team'][number] = {
      ...member,
      ...patch,
      instanceId: member.instanceId,
    }
    const team = [...dto.team]
    team[idx] = merged
    await this.store.writeJson(projectId, 'project.json', { ...dto, team, updatedAt: nowIso() })
    return merged
  }

  /** 停用/启用实例（D14-9：保留全部数据，可重新启用；archived 状态归档由会话层按 occupancy/停用派生）。 */
  async setMemberEnabled(projectId: string, instanceId: string, enabled: boolean): Promise<void> {
    await this.patchMember(projectId, instanceId, { enabled })
  }

  private async ensureUserSessionMeta(
    projectId: string,
    instanceId: string,
    displayName: string,
  ): Promise<void> {
    await this.store.ensureDir(projectId, 'sessions')
    const sid = `u_${instanceId}`
    const relPath = `sessions/${sid}.meta.json`
    if (await this.store.exists(projectId, relPath)) return
    await this.store.writeJson(projectId, relPath, buildUserSessionMeta(projectId, instanceId, displayName))
  }
}

/**
 * 判断工作目录类型：目录为空=empty；否则视为已有内容（existing-repo 兼容既有文件与 .git）。
 * M0 从简：两值枚举，细化留待 M1 创建向导。
 */
async function detectWorkdirKind(workdir: string): Promise<ProjectConfig['workdirKind']> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(workdir, { withFileTypes: true })
  } catch {
    return 'empty'
  }
  return entries.length === 0 ? 'empty' : 'existing-repo'
}
