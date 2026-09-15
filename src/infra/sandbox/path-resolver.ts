import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PathResolver, PathRoots, ResolvedPath, RootScheme } from '../../ports/path-resolver'
import { err, ok, type Result } from '../../shared/result'

const SCHEME_PATTERN = /^(workdir|ro|runtime):\/\//

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/')
}

function isInside(absolute: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(absolute))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 逻辑沙箱路径解析（sandbox.md §3）：
 * - 只接受 `workdir://` / `ro://` / `runtime://` 三种虚拟路径；
 * - 拒绝 `..` 逃逸、绝对路径、以及**符号链接指向根外**（对已存在路径做 realpath 复核）；
 * - `resolveForWrite` 允许目标文件尚不存在，但按最近的已存在父目录做同样的边界与链接复核。
 */
export function createPathResolver(): PathResolver {
  const rootFor = (scheme: RootScheme, roots: PathRoots): readonly string[] => {
    if (scheme === 'workdir') return [roots.workdir]
    if (scheme === 'runtime') return [roots.runtime]
    return roots.readonly
  }

  const checkEscapes = (absolute: string, allowed: readonly string[]): Result<string> => {
    // 逐级找到最近的已存在祖先，再 realpath 复核（防符号链接逃逸）
    let probe = absolute
    let guard = 0
    while (!existsSync(probe) && guard < 64) {
      const parent = resolve(probe, '..')
      if (parent === probe) break
      probe = parent
      guard += 1
    }
    if (!existsSync(probe)) return ok(absolute)
    let realProbe: string
    try {
      realProbe = realpathSync(probe)
    } catch {
      return err('ERR_FORBIDDEN_PATH', '路径不可访问', { path: absolute })
    }
    if (!allowed.some((root) => isInside(realProbe, root))) {
      return err('ERR_FORBIDDEN_PATH', '路径经符号链接逃逸出允许根', { path: absolute, real: realProbe })
    }
    return ok(absolute)
  }

  const resolveWith = (raw: string, roots: PathRoots, forWrite: boolean): Result<ResolvedPath> => {
    const trimmed = raw.trim()
    const match = SCHEME_PATTERN.exec(trimmed)
    if (match === null) {
      return err('ERR_FORBIDDEN_PATH', '路径必须使用虚拟 scheme（workdir:// ro:// runtime://）', { path: raw })
    }
    const scheme = match[1] as RootScheme
    const rest = trimmed.slice(match[0].length)
    if (isAbsolute(rest) || /^[a-zA-Z]:/.test(rest)) {
      return err('ERR_FORBIDDEN_PATH', '虚拟路径后必须是相对引用', { path: raw })
    }

    const allowed = rootFor(scheme, roots)
    if (allowed.length === 0) {
      return err('ERR_FORBIDDEN_PATH', `没有可用的允许根（${scheme}）`, { path: raw })
    }
    // 只读根不可写；workdir 与 runtime（项目运行时目录）可写
    if (scheme === 'ro' && forWrite) {
      return err('ERR_FORBIDDEN_PATH', '只读根不可写', { path: raw, scheme })
    }

    for (const root of allowed) {
      const absolute = resolve(root, rest)
      if (!isInside(absolute, root)) {
        return err('ERR_FORBIDDEN_PATH', '路径越界（.. 逃逸）', { path: raw, root })
      }
      const escaped = checkEscapes(absolute, allowed)
      if (!escaped.ok) return escaped
      return ok({ scheme, absolute, relPath: normalizeSeparators(relative(root, absolute)) })
    }
    return err('ERR_FORBIDDEN_PATH', '路径越界', { path: raw })
  }

  return {
    resolve(raw: string, roots: PathRoots): Result<ResolvedPath> {
      return resolveWith(raw, roots, false)
    },

    resolveForWrite(raw: string, roots: PathRoots): Result<ResolvedPath> {
      return resolveWith(raw, roots, true)
    },

    relativize(absolute: string, roots: PathRoots): string | null {
      const candidates: readonly { readonly scheme: RootScheme; readonly root: string }[] = [
        { scheme: 'workdir', root: roots.workdir },
        { scheme: 'runtime', root: roots.runtime },
        ...roots.readonly.map((root) => ({ scheme: 'ro' as const, root })),
      ]
      for (const candidate of candidates) {
        if (isInside(absolute, candidate.root)) {
          const rel = normalizeSeparators(relative(candidate.root, absolute))
          return `${candidate.scheme}://${rel}`
        }
      }
      return null
    },
  }
}

/** 平台路径拼接辅助（仅 infra/bootstrap 使用；业务代码走虚拟路径） */
export function joinUnder(root: string, rel: string): string {
  return resolve(root, ...normalizeSeparators(rel).split('/').filter((part) => part.length > 0 && part !== '.'))
}

export { sep as pathSeparator }
