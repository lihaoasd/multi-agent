import type { Result } from '../shared/result'

/**
 * 路径解析与边界校验端口（真源：docs/design/sandbox.md §3、abstraction.md §4.4）。
 * 虚拟路径方案：`workdir://<rel>`（项目工作目录）、`ro://<rel>`（平台只读资源）、`runtime://<rel>`（项目运行时目录）。
 * 任何解析结果必须落在允许根内；**符号链接逃逸同样拒绝**（ERR_FORBIDDEN_PATH）。
 */

export type RootScheme = 'workdir' | 'ro' | 'runtime'

export interface PathRoots {
  /** 项目工作目录（绝对路径） */
  readonly workdir: string
  /** 项目运行时目录（`<DATA_DIR>/projects/<pid>`，绝对路径） */
  readonly runtime: string
  /** 平台只读根（仓库内随代码分发的资源，绝对路径） */
  readonly readonly: readonly string[]
}

export interface ResolvedPath {
  readonly scheme: RootScheme
  /** 绝对路径（已通过边界与符号链接校验） */
  readonly absolute: string
  /** 相对根的引用（对外一律存相对路径，保证拷贝迁移语义） */
  readonly relPath: string
}

export interface PathResolver {
  /** 解析虚拟路径；越界/逃逸/未知 scheme → ERR_FORBIDDEN_PATH */
  resolve(raw: string, roots: PathRoots): Result<ResolvedPath>
  /** 把绝对路径反解为相对引用（用于归属表与 manifest） */
  relativize(absolute: string, roots: PathRoots): string | null
  /** 解析可写目录（父目录不存在时按父目录做边界校验） */
  resolveForWrite(raw: string, roots: PathRoots): Result<ResolvedPath>
}
