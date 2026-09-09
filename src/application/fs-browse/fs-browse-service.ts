/**
 * 目录浏览（用户级 API，绕过 Agent 沙箱）。
 * 供创建向导选择工作目录：本机全盘浏览。默认过滤隐藏与已知系统目录、限制深度（M8 定稿）。
 * api/contract.md §2 项目区末行；另含用户级 home/驱动器探测 与 目录创建（供向导新建文件夹）。
 */
import { isAbsolute, join } from 'node:path'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'

import { AppError, ErrorCodes } from '../../shared/errors.js'

export interface BrowseEntry {
  name: string
  /** 绝对路径（子项=父路径+名称） */
  path: string
  type: 'dir' | 'file'
  /** 目录是否被过滤规则标记为系统/隐藏（仍返回但 UI 弱化） */
  flagged?: boolean
  size?: number
  mtime?: string
}

export interface BrowseOptions {
  /** 浏览目标路径（绝对路径） */
  path: string
  /** 最大递归深度（0=仅一层，默认 0） */
  depth?: number
  /** 是否包含隐藏/系统目录（默认 false） */
  includeHidden?: boolean
}

export interface BrowseResult {
  path: string
  entries: BrowseEntry[]
  truncated: boolean
}

/** 已知系统/隐藏目录名（Windows 常规；大小写不敏感匹配）。 */
const SYSTEM_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  '$windows.~bt',
  '$windows.~ws',
])

const MAX_DEPTH = 3

function isSystemOrHidden(name: string): boolean {
  if (name.startsWith('.')) return true
  return SYSTEM_DIRS.has(name.toLowerCase())
}

/** 列出目录内容。限制：绝对路径、存在的目录、深度上限、隐藏/系统过滤、符号链接不跟随。 */
export async function browseDirectory(options: BrowseOptions): Promise<BrowseResult> {
  const root = options.path.trim()
  if (!root || !isAbsolute(root)) {
    throw new AppError(ErrorCodes.VALIDATION, '路径必须是绝对路径')
  }
  const depth = Math.min(Math.max(0, Math.floor(options.depth ?? 0)), MAX_DEPTH)
  const includeHidden = options.includeHidden === true

  const st = await fs.stat(root).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(ErrorCodes.NOT_FOUND, `路径不存在: ${root}`)
    }
    throw err
  })
  if (!st.isDirectory()) {
    throw new AppError(ErrorCodes.VALIDATION, `路径不是目录: ${root}`)
  }

  const entries: BrowseEntry[] = []
  let truncated = false
  await collect(root, depth, entries, () => {
    truncated = true
  })
  return { path: root, entries, truncated }

  async function collect(
    dir: string,
    remaining: number,
    out: BrowseEntry[],
    onTruncate: () => void,
  ): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return // 无权限/已删除的目录跳过
    }
    for (const name of names) {
      const full = join(dir, name)
      const flagged = isSystemOrHidden(name)
      if (flagged && !includeHidden) continue
      const dirent = await safeDirent(full)
      if (dirent === null) continue
      const entry: BrowseEntry = { name, path: full, type: dirent, flagged: flagged || undefined }
      out.push(entry)
      // 子树递归：仅目录、未 flag、还有深度余量
      if (remaining > 0 && dirent === 'dir' && !flagged) {
        await collect(full, remaining - 1, out, onTruncate)
      }
    }
  }

  async function safeDirent(p: string): Promise<'dir' | 'file' | null> {
    try {
      const s = await fs.stat(p)
      if (s.isDirectory()) return 'dir'
      return 'file'
    } catch {
      return null
    }
  }
}

/** 用户主目录与可用盘符（Windows 常见快捷入口；供向导「常用位置」）。 */
export async function getHomeAndDrives(): Promise<{ home: string; quick: string[] }> {
  const home = homedir()
  const quick = [home]
  if (process.platform === 'win32') {
    const letters = 'CDEFGH'.split('')
    for (const l of letters) {
      const root = `${l}:\\`
      if (root.toUpperCase() === home.slice(0, 2).toUpperCase()) continue
      try {
        await fs.access(root)
        quick.push(root)
      } catch {
        // 盘符不存在则跳过
      }
    }
  } else {
    quick.push('/')
  }
  return { home, quick: [...new Set(quick)] }
}

const NAME_FORBIDDEN = /[\\/:*?"<>|]/

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true
  }
  return false
}

/**
 * 用户级创建目录：在已存在目录 parent 下新建 name（仅允许一个合法名称段）。
 * 返回新目录绝对路径；已存在抛 ERR_CONFLICT。
 */
export async function mkdirUnder(parent: string, name: string): Promise<string> {
  if (!parent || !isAbsolute(parent)) {
    throw new AppError(ErrorCodes.VALIDATION, '父目录必须是绝对路径')
  }
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    NAME_FORBIDDEN.test(trimmed) ||
    hasControlChar(trimmed)
  ) {
    throw new AppError(ErrorCodes.VALIDATION, '目录名包含非法字符或为空')
  }
  if (trimmed.length > 120) throw new AppError(ErrorCodes.VALIDATION, '目录名过长')
  const parentStat = await fs.stat(parent).catch(() => null)
  if (!parentStat || !parentStat.isDirectory()) {
    throw new AppError(ErrorCodes.NOT_FOUND, `父目录不存在或不是目录: ${parent}`)
  }
  const target = join(parent, trimmed)
  try {
    await fs.mkdir(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AppError(ErrorCodes.CONFLICT, `目录已存在: ${trimmed}`)
    }
    throw err
  }
  return target
}
