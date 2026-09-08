/**
 * 文件存储地基：原子写 / 路径边界。
 * 规则对齐 data-storage.md §1：原子写=临时文件+rename；路径边界=所有对外引用先校验再解析。
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'

/** 判断 target 是否位于 root 内（或等于 root）。两者均需为绝对路径。 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * 将候选路径约束在 root 之内；越界抛 ERR_FORBIDDEN_PATH。
 * root 可为文件或目录。用于 file-store 一切写路径，防止目录穿越/越界写。
 */
export function ensureInside(root: string, candidate: string, what = 'path'): string {
  const absRoot = resolve(root)
  const absTarget = resolve(candidate)
  if (!isPathInside(absRoot, absTarget)) {
    throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：${what} 不在允许范围内 (${absTarget})`)
  }
  return absTarget
}

/** 原子写文本文件：写临时文件 → rename。 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** 原子写 JSON（格式化 + 末尾换行）。 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2) + '\n')
}

/** 读 JSON；文件不存在返回 null。 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new AppError(ErrorCodes.INTERNAL, `JSON 解析失败: ${filePath}`, String(err))
  }
}

/** 目录是否存在。 */
export async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(dirPath)
    return st.isDirectory()
  } catch {
    return false
  }
}
