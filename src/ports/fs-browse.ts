import type { Result } from '../shared/result'
import type { WorkdirKind } from './project'

/**
 * 目录浏览器端口（contract.md §2：`GET /api/fs/browse`）。
 * ⚠️ 这是**用户级 API，绕过 Agent 沙箱**（用于挑选项目工作目录，见 M8 定稿）；
 * Agent 侧的文件访问一律走 PathResolver + allowedRoots（S4）。
 */

export interface BrowseEntry {
  readonly name: string
  /** 绝对路径（父目录用 `parent`） */
  readonly path: string
  readonly isDirectory: boolean
  /** 是否看起来像代码仓库（含 `.git`） */
  readonly isRepo: boolean
  readonly hidden: boolean
}

export interface BrowseResult {
  /** 当前目录绝对路径；`null` 表示"根列表"（Windows 为盘符，POSIX 为 `/`） */
  readonly path: string | null
  readonly parent: string | null
  readonly entries: readonly BrowseEntry[]
  /** 是否因深度/数量上限被截断 */
  readonly truncated: boolean
}

export interface WorkdirInspection {
  /** 规范化后的绝对路径（application 层做前缀判定用，避免直接依赖 node:path） */
  readonly path: string
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly writable: boolean
  readonly entryCount: number
  readonly kind: WorkdirKind
}

export interface DirectoryBrowser {
  browse(path: string | null, opts?: { readonly includeHidden?: boolean }): Promise<Result<BrowseResult>>
  inspectWorkdir(path: string): Promise<Result<WorkdirInspection>>
}
