/**
 * 文件存储端口的默认实现（重构 P1，2026-09-14）。
 *
 * 行为契约逐条对齐迁移前的既有实现（见 `application/ports/storage.ts` 头注释）：
 * · 缺失文件 = 空集合；JSONL 坏行跳过；JSON 解析失败抛错；写原子；mutate 持锁。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { atomicWriteFile, atomicWriteJson, readJson } from '../file-store/fs-utils.js'
import { KeyedLock } from '../util/keyed-lock.js'
import type {
  DirectoryStore,
  JsonStore,
  JsonlStore,
  StoragePorts,
  StoreScope,
} from '../../ports/storage.js'
import { StorageRoot } from './storage-root.js'

/** 作用域 → 绝对路径。 */
function pathOf(scope: StoreScope): string {
  return scope.relPath ? join(scope.baseDir, scope.relPath) : scope.baseDir
}

/** 读文件为文本；不存在返回 null。 */
async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** 追加式 JSONL 的默认实现（含坏行容错）。 */
export class FileJsonlStore implements JsonlStore {
  private readonly lock = new KeyedLock()

  async readAll(scope: StoreScope): Promise<unknown[]> {
    const raw = await readTextOrNull(pathOf(scope))
    if (raw === null) return []
    const out: unknown[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // 坏行跳过（data-storage.md §9 损坏容错）
      }
    }
    return out
  }

  async readTail(scope: StoreScope, n: number): Promise<unknown[]> {
    const all = await this.readAll(scope)
    return all.slice(-n)
  }

  async append(scope: StoreScope, record: unknown): Promise<void> {
    const file = pathOf(scope)
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
  }

  async mutate(scope: StoreScope, fn: (all: unknown[]) => unknown[] | null): Promise<unknown[]> {
    const key = pathOf(scope)
    return this.lock.run(key, async () => {
      const current = await this.readAll(scope)
      const next = fn(current)
      if (next === null) return current
      const file = pathOf(scope)
      await fs.mkdir(dirname(file), { recursive: true })
      // 整文件重写：每行一条 JSON + 末尾换行（与迁移前各 store 的手写格式逐字节一致）
      await atomicWriteFile(file, next.map((r) => JSON.stringify(r)).join('\n') + '\n')
      return next
    })
  }
}

/** 单文件 JSON 的默认实现。 */
export class FileJsonStore implements JsonStore {
  private readonly lock = new KeyedLock()

  async read(scope: StoreScope): Promise<unknown | null> {
    return readJson<unknown>(pathOf(scope))
  }

  async write(scope: StoreScope, value: unknown): Promise<void> {
    await atomicWriteJson(pathOf(scope), value)
  }

  async mutate<T>(scope: StoreScope, fn: (current: unknown) => unknown | null): Promise<T> {
    const key = pathOf(scope)
    return this.lock.run(key, async () => {
      const current = await readJson<unknown>(pathOf(scope))
      const next = fn(current)
      if (next !== null) await atomicWriteJson(pathOf(scope), next)
      return (next === null ? current : next) as T
    })
  }
}

/** 目录列举的默认实现。 */
export class FileDirectoryStore implements DirectoryStore {
  async list(scope: StoreScope): Promise<string[]> {
    try {
      return await fs.readdir(pathOf(scope))
    } catch {
      return []
    }
  }
}

/** 组装默认文件存储端口。 */
export function createFileStorage(projectsRoot: string): StoragePorts & { root: StorageRoot } {
  const root = new StorageRoot(projectsRoot)
  return {
    root,
    jsonl: new FileJsonlStore(),
    json: new FileJsonStore(),
    dir: new FileDirectoryStore(),
  }
}
