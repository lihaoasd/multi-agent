import type { Result } from '../shared/result'

/**
 * 工作目录文件读写端口（真源：docs/design/workspaces-artifacts.md §1/§2、sandbox.md）。
 * 只接受**相对工作目录根**的 relPath（虚拟路径的解析与越界拦截由 `PathResolver` 在工具层先做）；
 * 实现内部仍做一次防御性包含性校验（拒绝绝对路径与 `..` 逃逸）。
 */

export interface WorkdirFileSnapshot {
  readonly relPath: string
  readonly content: string
  readonly hash: string
  readonly bytes: number
}

export interface WorkdirWriteResult {
  readonly relPath: string
  readonly action: 'add' | 'modify'
  /** 写入前内容（文件不存在时为 null）——版本存储的 base 内容 */
  readonly before: string | null
  readonly hash: string
  readonly bytes: number
  /** 行级 diff 摘要（工具回执与 manifest 用） */
  readonly diff: { readonly add: number; readonly del: number }
}

export interface WorkdirDeleteResult {
  readonly relPath: string
  readonly action: 'delete'
  readonly before: string
  readonly diff: { readonly add: number; readonly del: number }
}

export interface WorkdirFs {
  /** 读文件；不存在返回 ok(null)；非文本（二进制过大）返回 ERR_VALIDATION */
  read(root: string, relPath: string): Promise<Result<WorkdirFileSnapshot | null>>
  write(root: string, relPath: string, content: string): Promise<Result<WorkdirWriteResult>>
  remove(root: string, relPath: string): Promise<Result<WorkdirDeleteResult>>
  hash(root: string, relPath: string): Promise<string | null>
  exists(root: string, relPath: string): Promise<boolean>
}
