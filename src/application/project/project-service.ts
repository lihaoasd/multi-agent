/**
 * 项目应用服务：项目 CRUD（M0 纯数据版）。
 * 运行时位置：dataDir/projects/<projectId>/（data-storage.md §2）；本阶段仅落 project.json，
 * workspaces/sessions 等由 M1 创建。绝不触碰用户工作目录。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso, genId } from '../../infra/util/id.js'
import { atomicWriteJson, dirExists, readJson } from '../../infra/file-store/fs-utils.js'
import type { ProjectConfig } from '../../shared/types/project.js'

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
    private readonly projectsRoot: string, // dataDir/projects
    private readonly projectDefaults: {
      artifactPolicy: ProjectConfig['artifactPolicy']
      approvalPolicy: ProjectConfig['approvalPolicy']
    },
  ) {}

  private runtimeDir(projectId: string): string {
    return join(this.projectsRoot, projectId)
  }

  private projectFile(projectId: string): string {
    return join(this.runtimeDir(projectId), 'project.json')
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

    const runtimeDir = this.runtimeDir(id)
    await fs.mkdir(runtimeDir, { recursive: true })
    await atomicWriteJson(this.projectFile(id), project)
    return project
  }

  async list(): Promise<ProjectDto[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.projectsRoot)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const dtos: ProjectDto[] = []
    for (const name of names) {
      if (!name.startsWith(PROJECT_ID_PREFIX)) continue
      const dto = await readJson<ProjectDto>(this.projectFile(name))
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
    return readJson<ProjectDto>(this.projectFile(projectId))
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
    await atomicWriteJson(this.projectFile(projectId), next)
    return next
  }

  /** 删除仅运行时项目文件夹（data/projects/<pid>）；不影响用户工作目录。 */
  async remove(projectId: string): Promise<void> {
    const dto = await this.get(projectId)
    void dto // M0 无运行中状态需要拦截；M1+ 按 architecture §7 增加占用校验
    await fs.rm(this.runtimeDir(projectId), { recursive: true, force: true })
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
