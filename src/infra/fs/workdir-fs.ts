import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  WorkdirDeleteResult,
  WorkdirFileSnapshot,
  WorkdirFs,
  WorkdirWriteResult,
} from '../../ports/workdir'
import { diffSummary } from '../../domain/rules/diff'
import { err, ok, type Result } from '../../shared/result'

/**
 * 工作目录文件读写（workspaces-artifacts.md §1/§2）：
 * relPath 一律相对工作目录根；实现内做**防御性包含性校验**（拒绝绝对路径与 `..` 逃逸），
 * 虚拟路径（`workdir://`）的解析与符号链接逃逸拦截在 `PathResolver`（工具层）先行完成。
 */

const MAX_TEXT_BYTES = 2 * 1024 * 1024

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function resolveInside(root: string, relPath: string): Result<string> {
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.trim().length === 0) return err('ERR_VALIDATION', '文件路径不能为空')
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    return err('ERR_FORBIDDEN_PATH', `路径必须是工作目录内的相对路径：${relPath}`, { relPath })
  }
  const absolute = resolve(root, normalized)
  const rel = relative(resolve(root), absolute)
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || rel.length === 0) {
    return err('ERR_FORBIDDEN_PATH', `路径逃逸工作目录：${relPath}`, { relPath })
  }
  return ok(absolute)
}

export function createWorkdirFs(): WorkdirFs {
  const readSnapshot = async (root: string, relPath: string): Promise<Result<WorkdirFileSnapshot | null>> => {
    const resolved = resolveInside(root, relPath)
    if (!resolved.ok) return resolved
    try {
      const info = await stat(resolved.value)
      if (!info.isFile()) return err('ERR_VALIDATION', `不是普通文件：${relPath}`, { relPath })
      if (info.size > MAX_TEXT_BYTES) {
        return err('ERR_VALIDATION', `文件过大（>2MB），MVP 只支持文本文件：${relPath}`, { relPath })
      }
      const content = await readFile(resolved.value, 'utf8')
      return ok({ relPath: relPath.replace(/\\/g, '/'), content, hash: hashOf(content), bytes: info.size })
    } catch (cause) {
      const code = (cause as { code?: string }).code
      if (code === 'ENOENT') return ok(null)
      return err('ERR_INTERNAL', `读取失败：${relPath} ${String(cause)}`, { relPath })
    }
  }

  return {
    read: readSnapshot,

    async exists(root, relPath): Promise<boolean> {
      const resolved = resolveInside(root, relPath)
      if (!resolved.ok) return false
      try {
        return (await stat(resolved.value)).isFile()
      } catch {
        return false
      }
    },

    async hash(root, relPath): Promise<string | null> {
      const snapshot = await readSnapshot(root, relPath)
      return snapshot.ok && snapshot.value !== null ? snapshot.value.hash : null
    },

    async write(root, relPath, content): Promise<Result<WorkdirWriteResult>> {
      const resolved = resolveInside(root, relPath)
      if (!resolved.ok) return resolved
      const before = await readSnapshot(root, relPath)
      if (!before.ok) return before
      try {
        await mkdir(dirname(resolved.value), { recursive: true })
        await writeFile(resolved.value, content, 'utf8')
      } catch (cause) {
        return err('ERR_INTERNAL', `写入失败：${relPath} ${String(cause)}`, { relPath })
      }
      return ok({
        relPath: relPath.replace(/\\/g, '/'),
        action: before.value === null ? 'add' : 'modify',
        before: before.value?.content ?? null,
        hash: hashOf(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        diff: diffSummary(before.value?.content ?? null, content),
      })
    },

    async remove(root, relPath): Promise<Result<WorkdirDeleteResult>> {
      const resolved = resolveInside(root, relPath)
      if (!resolved.ok) return resolved
      const before = await readSnapshot(root, relPath)
      if (!before.ok) return before
      if (before.value === null) return err('ERR_NOT_FOUND', `文件不存在：${relPath}`, { relPath })
      try {
        await rm(resolved.value)
      } catch (cause) {
        return err('ERR_INTERNAL', `删除失败：${relPath} ${String(cause)}`, { relPath })
      }
      return ok({
        relPath: relPath.replace(/\\/g, '/'),
        action: 'delete',
        before: before.value.content,
        diff: diffSummary(before.value.content, null),
      })
    },
  }
}

/** 供工具层复用：把工具算出的绝对路径反解为工作目录内 relPath（越界返回 null） */
export function relativizeInside(root: string, absolute: string): string | null {
  const rel = relative(resolve(root), resolve(absolute)).replace(/\\/g, '/')
  if (rel.length === 0 || rel.startsWith('..') || join(root, rel) === root) return null
  return rel
}
