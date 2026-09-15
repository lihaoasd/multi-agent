import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { DirEntry, FileStat, FileStore, RelPath, WriteReceipt } from '../../ports/file-store'
import { err, ok, type Result } from '../../shared/result'

export interface FileStoreOptions {
  /** 根目录（相对路径一律相对它解析） */
  readonly root: string
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 文件系统适配器：**原子写**（临时文件 + rename）、JSONL 追加、目录列举。
 * 路径安全：只接受相对根目录的路径，`..` 逃逸返回 ERR_FORBIDDEN_PATH（真正的沙箱边界在 PathResolver，S4 接入）。
 */
export function createFileStore(options: FileStoreOptions): FileStore {
  const root = resolve(options.root)

  const toAbsolute = (path: RelPath): Result<string> => {
    if (path.length === 0) return err('ERR_VALIDATION', '路径不能为空')
    if (isAbsolute(path)) return err('ERR_FORBIDDEN_PATH', '路径必须相对根目录', { path })
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return err('ERR_FORBIDDEN_PATH', '路径越界', { path })
    }
    return ok(absolute)
  }

  const store: FileStore = {
    root,

    async readText(path: RelPath): Promise<Result<string>> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return absolute
      try {
        return ok(await readFile(absolute.value, 'utf8'))
      } catch (cause) {
        if (isNodeError(cause) && cause.code === 'ENOENT') {
          return err('ERR_NOT_FOUND', '文件不存在', { path })
        }
        return err('ERR_INTERNAL', '读取文件失败', { path, cause: String(cause) })
      }
    },

    async readJson<T>(path: RelPath): Promise<Result<T>> {
      const text = await store.readText(path)
      if (!text.ok) return text
      try {
        return ok(JSON.parse(text.value) as T)
      } catch (cause) {
        return err('ERR_VALIDATION', '文件内容不是合法 JSON', { path, cause: String(cause) })
      }
    },

    async writeTextAtomic(
      path: RelPath,
      content: string,
      opts?: { readonly expectedHash?: string },
    ): Promise<Result<WriteReceipt>> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return absolute

      if (opts?.expectedHash !== undefined) {
        const current = await store.hash(path)
        if (current !== opts.expectedHash) {
          return err('ERR_CONFLICT', '文件已被其它写入方修改', { path })
        }
      }

      const temp = `${absolute.value}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try {
        await mkdir(dirname(absolute.value), { recursive: true })
        await writeFile(temp, content, 'utf8')
        await rename(temp, absolute.value)
        return ok({ path, bytes: Buffer.byteLength(content, 'utf8'), hash: sha256(content) })
      } catch (cause) {
        await rm(temp, { force: true }).catch(() => undefined)
        return err('ERR_INTERNAL', '写入文件失败', { path, cause: String(cause) })
      }
    },

    async writeJsonAtomic<T>(path: RelPath, value: T): Promise<Result<WriteReceipt>> {
      return store.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
    },

    async appendLine(path: RelPath, line: string): Promise<Result<void>> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return absolute
      try {
        await mkdir(dirname(absolute.value), { recursive: true })
        await appendFile(absolute.value, `${line}\n`, 'utf8')
        return ok(undefined)
      } catch (cause) {
        return err('ERR_INTERNAL', '追加写入失败', { path, cause: String(cause) })
      }
    },

    async list(dir: RelPath): Promise<Result<DirEntry[]>> {
      const absolute = toAbsolute(dir)
      if (!absolute.ok) return absolute
      try {
        const entries = await readdir(absolute.value, { withFileTypes: true })
        const result: DirEntry[] = []
        for (const entry of entries) {
          const isDirectory = entry.isDirectory()
          let size = 0
          if (!isDirectory) {
            const info = await stat(resolve(absolute.value, entry.name)).catch(() => null)
            size = info?.size ?? 0
          }
          result.push({ name: entry.name, isDirectory, size })
        }
        return ok(result)
      } catch (cause) {
        if (isNodeError(cause) && cause.code === 'ENOENT') {
          return err('ERR_NOT_FOUND', '目录不存在', { path: dir })
        }
        return err('ERR_INTERNAL', '列举目录失败', { path: dir, cause: String(cause) })
      }
    },

    async stat(path: RelPath): Promise<FileStat | null> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return null
      try {
        const info = await stat(absolute.value)
        return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() }
      } catch {
        return null
      }
    },

    async exists(path: RelPath): Promise<boolean> {
      return (await store.stat(path)) !== null
    },

    async hash(path: RelPath): Promise<string | null> {
      const text = await store.readText(path)
      return text.ok ? sha256(text.value) : null
    },

    async ensureDir(path: RelPath): Promise<Result<void>> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return absolute
      try {
        await mkdir(absolute.value, { recursive: true })
        return ok(undefined)
      } catch (cause) {
        return err('ERR_INTERNAL', '创建目录失败', { path, cause: String(cause) })
      }
    },

    async remove(path: RelPath): Promise<Result<void>> {
      const absolute = toAbsolute(path)
      if (!absolute.ok) return absolute
      try {
        await rm(absolute.value, { force: true, recursive: true })
        return ok(undefined)
      } catch (cause) {
        return err('ERR_INTERNAL', '删除失败', { path, cause: String(cause) })
      }
    },
  }

  return store
}
