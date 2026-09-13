/**
 * 文件存储地基：原子写 / 路径边界。
 * 规则对齐 data-storage.md §1：原子写=临时文件+rename；路径边界=所有对外引用先校验再解析。
 *
 * 路径边界判定的**权威定义在 domain**（`domain/rules/path-boundary.ts`），此处 re-export 保持
 * 既有调用方不变（P2：原先定义在这里，导致 domain 反向依赖 infra）。
 */
import { dirname, join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { ensureInside, isPathInside } from '../../domain/rules/path-boundary.js'

// 路径边界判定的权威定义已归位 domain（P2）；此处 re-export，既有调用方无需改动。
export { ensureInside, isPathInside }

/** 原子写文本文件：写临时文件 → rename（Windows 上目标被并发读时 rename 可能 EPERM/EBUSY，短暂重试）。 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await renameWithRetry(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** rename 重试：仅对并发读导致的瞬时错误重试（EPERM/EBUSY/EACCES），其余直接抛出。 */
async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  const delays = [0, 20, 50, 100, 200, 400]
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      await fs.rename(tmp, filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retryable || i === delays.length - 1) throw err
    }
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
