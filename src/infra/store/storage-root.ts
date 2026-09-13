/**
 * 项目根路径解析（重构 P1，2026-09-14）。
 *
 * application 层不再接触 `node:path` / 绝对路径：它只给 `{projectId, relPath}`，
 * 由这里拼出绝对路径并做越界校验（防止 `..` 逃出项目运行时目录）。
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AppError, ErrorCodes } from '../../shared/errors.js'

/** 项目作用域寻址：projectId 决定项目目录，relPath 是目录内的相对路径。 */
export interface ProjectLocator {
  projectId: string
  relPath: string
}

/** 判断 target 是否位于 root 内（或等于 root）。两者均需为绝对路径。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 存储根：projectsRoot 下每个项目一个运行时目录。 */
export class StorageRoot {
  constructor(private readonly projectsRoot: string) {}

  /** projectsRoot（供门面在同一根下继续派生作用域）。 */
  get root(): string {
    return this.projectsRoot
  }

  /** 项目运行时目录（不存在时按需创建由写入方负责）。 */
  projectDir(projectId: string): string {
    return join(this.projectsRoot, projectId)
  }

  /** 换根：在同一存储实现下派生"以另一绝对目录为根"的作用域解析器（不复制任何状态）。 */
  reRoot(absRoot: string): StorageRoot {
    return new StorageRoot(absRoot)
  }

  /**
   * 解析逻辑地址为绝对路径，并保证落在项目运行时目录内。
   * relPath 为空视为项目目录本身（用于目录列举）。
   */
  resolve(loc: ProjectLocator): string {
    const base = this.projectDir(loc.projectId)
    return this.resolveRaw(base, loc.relPath, loc.projectId)
  }

  /**
   * 以给定绝对目录为根解析相对路径（测试/迁移兼容路径用），同样做越界校验。
   * @param baseAbs 绝对目录
   * @param relPath 相对路径（`/` 或 `\` 分隔）
   * @param label 出错信息里的作用域标识
   */
  resolveRaw(baseAbs: string, relPath: string, label: string): string {
    const base = resolve(baseAbs)
    const target = relPath ? resolve(base, relPath) : base
    if (!isInside(base, target)) {
      throw new AppError(
        ErrorCodes.FORBIDDEN_PATH,
        `存储路径越界：${relPath} 不在项目运行时目录内（${label}）`,
      )
    }
    return target
  }
}
