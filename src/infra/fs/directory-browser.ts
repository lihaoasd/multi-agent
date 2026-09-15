import { constants, type Dirent } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { BrowseEntry, BrowseResult, DirectoryBrowser, WorkdirInspection } from '../../ports/fs-browse'
import type { WorkdirKind } from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

export interface DirectoryBrowserOptions {
  /** 单次返回的最大条目数（超出置 truncated） */
  readonly maxEntries?: number
  /** 默认是否包含隐藏项（以 `.` 开头）；系统目录始终过滤 */
  readonly includeHiddenByDefault?: boolean
}

const WINDOWS_SYSTEM_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'perflogs',
  'config.msi',
])

function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Windows 盘符列表（A: 起逐个探测；数量少，成本可接受） */
async function listWindowsRoots(): Promise<BrowseEntry[]> {
  const roots: BrowseEntry[] = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const path = `${letter}:\\`
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        roots.push({ name: path, path, isDirectory: true, isRepo: false, hidden: false })
      }
    } catch {
      // 未挂载：跳过
    }
  }
  return roots
}

/**
 * 目录浏览器（用户级，绕过 Agent 沙箱）：
 * - 过滤系统目录与（默认）隐藏目录，避免把 `C:\Windows` 这类目录塞给用户；
 * - `depth` 概念由"一次一层 + parent 回退"承担（UI 逐层浏览，避免递归扫盘）。
 */
export function createDirectoryBrowser(options: DirectoryBrowserOptions = {}): DirectoryBrowser {
  const maxEntries = options.maxEntries ?? 500
  const includeHiddenDefault = options.includeHiddenByDefault ?? false

  const browser: DirectoryBrowser = {
    async browse(path: string | null, opts?: { includeHidden?: boolean }): Promise<Result<BrowseResult>> {
      const includeHidden = opts?.includeHidden ?? includeHiddenDefault

      if (path === null || path.trim().length === 0) {
        if (!isWindows()) {
          return browser.browse('/', opts)
        }
        return ok({ path: null, parent: null, entries: await listWindowsRoots(), truncated: false })
      }

      // 只接受绝对路径：相对路径按服务端 cwd 解析会让用户困惑，直接拒绝
      if (!isAbsolute(path)) {
        return err('ERR_VALIDATION', 'path 必须是绝对路径', { path })
      }
      const target = resolve(path)

      let entries: Dirent[]
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return err('ERR_NOT_FOUND', '目录不存在', { path: target })
        if (code === 'EACCES' || code === 'EPERM') return err('ERR_FORBIDDEN', '目录不可访问', { path: target })
        return err('ERR_INTERNAL', '读取目录失败', { path: target, cause: String(cause) })
      }

      const items: BrowseEntry[] = []
      for (const entry of entries) {
        const hidden = entry.name.startsWith('.')
        if (!includeHidden && hidden) continue
        if (isWindows() && WINDOWS_SYSTEM_DIRS.has(entry.name.toLowerCase())) continue
        const childPath = join(target, entry.name)
        const isDirectory = entry.isDirectory()
        let isRepo = false
        if (isDirectory) {
          try {
            isRepo = (await stat(join(childPath, '.git'))).isDirectory()
          } catch {
            isRepo = false
          }
        }
        items.push({ name: entry.name, path: childPath, isDirectory, isRepo, hidden })
      }

      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })

      const truncated = items.length > maxEntries
      const parent = resolve(target, '..')
      return ok({
        path: target,
        parent: parent === target ? null : parent,
        entries: truncated ? items.slice(0, maxEntries) : items,
        truncated,
      })
    },

    async inspectWorkdir(path: string): Promise<Result<WorkdirInspection>> {
      const target = resolve(path)
      try {
        const info = await stat(target)
        if (!info.isDirectory()) {
          return ok({ path: target, exists: true, isDirectory: false, writable: false, entryCount: 0, kind: 'empty' })
        }
        let writable = true
        try {
          await access(target, constants.W_OK)
        } catch {
          writable = false
        }
        const entries = await readdir(target)
        const visible = entries.filter((name) => name !== '.git' && !name.startsWith('.'))
        const hasGit = entries.includes('.git')
        const kind: WorkdirKind = hasGit || visible.length > 0 ? 'existing-repo' : 'empty'
        return ok({ path: target, exists: true, isDirectory: true, writable, entryCount: entries.length, kind })
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return ok({ path: target, exists: false, isDirectory: false, writable: false, entryCount: 0, kind: 'empty' })
        }
        return err('ERR_INTERNAL', '检查工作目录失败', { path: target, cause: String(cause) })
      }
    },
  }

  return browser
}
