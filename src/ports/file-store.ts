import type { Result } from '../shared/result'

/**
 * 文件存储端口（真源：docs/design/abstraction.md §4.3/§4.6）。
 * 约定：路径一律为**相对根目录**的引用（保证拷贝迁移语义）；原子写=临时文件 + rename。
 * 失败语义：读不存在 → ERR_NOT_FOUND；内容非法 → ERR_VALIDATION；越界路径 → ERR_FORBIDDEN_PATH。
 */
export type RelPath = string

export interface DirEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly size: number
}

export interface FileStat {
  readonly size: number
  readonly mtimeMs: number
  readonly isDirectory: boolean
}

export interface WriteReceipt {
  readonly path: RelPath
  readonly bytes: number
  readonly hash: string
}

export interface FileStore {
  /** 磁盘根（绝对路径）：仅用于日志与诊断，业务代码不得拼接 */
  readonly root: string
  readText(path: RelPath): Promise<Result<string>>
  readJson<T>(path: RelPath): Promise<Result<T>>
  /** `expectedHash` 用于乐观并发：磁盘内容已被他人改动则 ERR_CONFLICT */
  writeTextAtomic(
    path: RelPath,
    content: string,
    opts?: { readonly expectedHash?: string },
  ): Promise<Result<WriteReceipt>>
  writeJsonAtomic<T>(path: RelPath, value: T): Promise<Result<WriteReceipt>>
  appendLine(path: RelPath, line: string): Promise<Result<void>>
  list(dir: RelPath): Promise<Result<DirEntry[]>>
  stat(path: RelPath): Promise<FileStat | null>
  exists(path: RelPath): Promise<boolean>
  /** 文件内容 sha256；不存在返回 null */
  hash(path: RelPath): Promise<string | null>
  /** 重命名/移动（日志轮转需要原子改名；目标存在则由实现决定覆盖语义） */
  move(from: RelPath, to: RelPath): Promise<Result<void>>
  ensureDir(path: RelPath): Promise<Result<void>>
  remove(path: RelPath): Promise<Result<void>>
}
