/**
 * 虚拟路径解析与 L0 文件系统边界（sandbox.md §3）。
 * Agent 只可见逻辑路径（scheme://rel），映射到真实根并校验落在边界内。
 * 所有文件工具先 resolve 后操作，越界抛 FS_BOUNDARY（内部简码）。
 */
import { isAbsolute, join, resolve } from 'node:path'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { isPathInside } from '../../infra/file-store/fs-utils.js'

export type VirtualScheme = 'ws' | 'workdir' | 'ro' | 'runtime'

export interface PathRoots {
  /** 该 Agent 私有工作区根 */
  wsRoot: string
  /** 项目工作目录根 */
  workdirRoot: string
  /** 只读平台资源根 */
  roRoots: string[]
  /** 运行时项目数据根（Agent 不可写） */
  runtimeRoot: string
}

export interface ResolvedPath {
  scheme: VirtualScheme
  /** 相对该 scheme 根的路径 */
  rel: string
  /** 真实绝对路径 */
  absolute: string
}

const SCHEME_RE = /^(ws|workdir|ro|runtime):\/\/(.*)$/s

/** 解析虚拟路径；非法/越界抛 ERR_FORBIDDEN_PATH。 */
export function resolveVirtual(path: string, roots: PathRoots): ResolvedPath {
  if (isAbsolute(path)) {
    // 绝对路径输入：强制视为越界（须用 scheme，sandbox §3.2）
    throw new AppError(
      ErrorCodes.FORBIDDEN_PATH,
      `路径越界：须用虚拟路径(scheme://)，收到绝对路径: ${path}`,
    )
  }
  const m = SCHEME_RE.exec(path)
  if (!m) {
    throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：无法识别的路径格式: ${path}`)
  }
  const scheme = m[1] as VirtualScheme
  const rel = m[2]?.replace(/^[/\\]+/, '') ?? ''
  switch (scheme) {
    case 'ws':
      return contain(roots.wsRoot, rel, scheme)
    case 'workdir':
      return contain(roots.workdirRoot, rel, scheme)
    case 'ro': {
      const abs = pickRo(roots.roRoots, rel)
      return { scheme, rel, absolute: abs }
    }
    case 'runtime':
      return contain(roots.runtimeRoot, rel, scheme)
    default:
      throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：未知 scheme: ${scheme}`)
  }
}

function contain(root: string, rel: string, scheme: VirtualScheme): ResolvedPath {
  const abs = resolve(join(root, rel))
  if (!isPathInside(root, abs)) {
    throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：${scheme}://${rel} 超出允许范围`)
  }
  return { scheme, rel, absolute: abs }
}

/** ro:// 选择第一个包含该 rel 的根（不存在→越界）。 */
function pickRo(roRoots: string[], rel: string): string {
  for (const root of roRoots) {
    const abs = resolve(join(root, rel))
    if (isPathInside(root, abs)) return abs
  }
  throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：ro://${rel} 不在只读资源范围内`)
}
