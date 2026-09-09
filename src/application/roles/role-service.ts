/**
 * 角色库服务：内置模板（仓库 src/shared/roles，只读）+ 用户自建模板（data/roles）。
 * data-storage.md §8：内置模板只读、不可原地改/删；变更走「基于内置复制新建」。
 */
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso } from '../../infra/util/id.js'
import { dirExists } from '../../infra/file-store/fs-utils.js'
import type { RoleTemplate } from '../../shared/types/role.js'

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** 解析模板文件原始 YAML（不含 source 元数据）。 */
type RoleFileShape = Omit<RoleTemplate, 'source' | 'createdAt' | 'updatedAt'>

/** 创建入参：字段可选，完整性由 create 运行时校验（含 roleId 必填与命名）。 */
export type RoleCreateInput = Partial<RoleFileShape>

export class RoleService {
  constructor(
    private readonly builtinDir: string,
    private readonly customDir: string,
  ) {}

  private customFile(roleId: string): string {
    return join(this.customDir, `${roleId}.yaml`)
  }

  /** 列出全部模板（内置 + 自定义，按 roleId 排序）。 */
  async list(): Promise<RoleTemplate[]> {
    const out: RoleTemplate[] = []
    for (const { dir, source } of [
      { dir: this.builtinDir, source: 'builtin' as const },
      { dir: this.customDir, source: 'custom' as const },
    ]) {
      if (!(await dirExists(dir))) continue
      const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml'))
      for (const f of files) {
        const roleId = f.slice(0, -'.yaml'.length)
        const tpl = await this.loadOne(join(dir, f), source, roleId).catch(() => null)
        if (tpl) out.push(tpl)
      }
    }
    return out.sort((a, b) => a.roleId.localeCompare(b.roleId))
  }

  /** 按 roleId 取模板；不存在抛 ERR_NOT_FOUND。 */
  async get(roleId: string): Promise<RoleTemplate> {
    const builtin = await this.loadIfExists(this.builtinDir, roleId, 'builtin')
    if (builtin) return builtin
    const custom = await this.loadIfExists(this.customDir, roleId, 'custom')
    if (custom) return custom
    throw new AppError(ErrorCodes.NOT_FOUND, `角色模板不存在: ${roleId}`)
  }

  /** 内置模板是否存在（供实例创建时校验引用，也用于「基于内置复制」提示）。 */
  async isBuiltin(roleId: string): Promise<boolean> {
    return (await this.loadIfExists(this.builtinDir, roleId, 'builtin')) !== null
  }

  private async loadIfExists(
    dir: string,
    roleId: string,
    source: RoleTemplate['source'],
  ): Promise<RoleTemplate | null> {
    const f = join(dir, `${roleId}.yaml`)
    if (!(await dirExists(dir))) return null
    try {
      await readFile(f, 'utf8')
    } catch {
      return null
    }
    return this.loadOne(f, source, roleId)
  }

  private async loadOne(
    f: string,
    source: RoleTemplate['source'],
    roleId: string,
  ): Promise<RoleTemplate> {
    const raw = await readFile(f, 'utf8')
    const shape = parseYaml(raw) as RoleFileShape
    if (!shape || typeof shape.roleId !== 'string' || shape.roleId !== roleId) {
      throw new AppError(ErrorCodes.INTERNAL, `角色模板文件损坏(roleId 不一致): ${f}`)
    }
    if (!this.validateShape(shape)) {
      throw new AppError(ErrorCodes.INTERNAL, `角色模板字段缺失: ${roleId}`)
    }
    return {
      ...shape,
      systemPrompt: shape.systemPrompt ?? '',
      tools: shape.tools ?? [],
      artifactTypes: shape.artifactTypes ?? [],
      defaultApprovalRules: shape.defaultApprovalRules ?? {},
      source,
    }
  }

  private validateShape(s: Partial<RoleFileShape>): boolean {
    return (
      typeof s.roleId === 'string' &&
      typeof s.name === 'string' &&
      typeof s.description === 'string' &&
      typeof s.defaultModel === 'string' &&
      typeof s.defaultLoop?.strategy === 'string' &&
      Array.isArray(s.tools) &&
      Array.isArray(s.artifactTypes)
    )
  }

  /** 创建自定义模板。roleId 不能与内置同名（防覆盖内置，data-storage §8）。 */
  async create(input: RoleCreateInput): Promise<RoleTemplate> {
    const roleId = input.roleId?.trim()
    if (!roleId || !ROLE_ID_PATTERN.test(roleId)) {
      throw new AppError(ErrorCodes.VALIDATION, 'roleId 需为小写字母数字连字符（2~32 位）')
    }
    if (await this.isBuiltin(roleId)) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `内置模板不可覆盖: ${roleId}；请用新 roleId「基于内置复制」`,
      )
    }
    try {
      await readFile(this.customFile(roleId), 'utf8')
      throw new AppError(ErrorCodes.CONFLICT, `自定义模板已存在: ${roleId}`)
    } catch (err) {
      if (err instanceof AppError) throw err
      // ENOENT = 不存在，可创建
    }
    if (!this.validateShape(input)) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        '模板字段不完整（roleId/name/description/defaultModel/defaultLoop/tools/artifactTypes）',
      )
    }
    const ts = nowIso()
    const full = { ...input, roleId } as RoleFileShape // validateShape 已确认字段完整
    const tpl: RoleTemplate = { ...full, source: 'custom', createdAt: ts, updatedAt: ts }
    await this.writeCustom(tpl)
    return tpl
  }

  /** 更新自定义模板（内置模板拒绝，提示复制新建）。 */
  async update(roleId: string, patch: Partial<RoleFileShape>): Promise<RoleTemplate> {
    if (await this.isBuiltin(roleId)) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `内置模板只读，不可修改: ${roleId}；请「基于内置复制新建」`,
      )
    }
    const cur = await this.get(roleId) // 不存在 → NOT_FOUND
    if (cur.source !== 'custom')
      throw new AppError(ErrorCodes.CONFLICT, `只允许修改自定义模板: ${roleId}`)
    const next: RoleTemplate = {
      ...cur,
      ...patch,
      roleId: cur.roleId, // roleId 不可改（改=新建）
      updatedAt: nowIso(),
    }
    if (!this.validateShape(next)) {
      throw new AppError(ErrorCodes.VALIDATION, '更新后模板字段不完整')
    }
    await this.writeCustom(next)
    return next
  }

  /** 删除自定义模板。内置模板拒绝。 */
  async remove(roleId: string): Promise<void> {
    if (await this.isBuiltin(roleId)) {
      throw new AppError(ErrorCodes.CONFLICT, `内置模板不可删除: ${roleId}`)
    }
    const cur = await this.get(roleId)
    if (cur.source !== 'custom')
      throw new AppError(ErrorCodes.CONFLICT, `只允许删除自定义模板: ${roleId}`)
    await rm(this.customFile(roleId), { force: true })
  }

  private async writeCustom(tpl: RoleTemplate): Promise<void> {
    // 落盘时去掉派生元数据，仅存文件形状
    const {
      roleId,
      name,
      category,
      description,
      systemPrompt,
      defaultModel,
      defaultLoop,
      tools,
      artifactTypes,
      defaultApprovalRules,
    } = tpl
    const file = this.customFile(roleId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      stringifyYaml(
        {
          roleId,
          name,
          category,
          description,
          systemPrompt,
          defaultModel,
          defaultLoop,
          tools,
          artifactTypes,
          defaultApprovalRules,
        },
        { lineWidth: 0 },
      ),
      'utf8',
    )
  }
}
