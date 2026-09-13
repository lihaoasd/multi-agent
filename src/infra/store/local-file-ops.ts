/**
 * `FileOps` 端口的默认实现（重构 P1c，2026-09-14）。
 *
 * 说明：本文件是 application 层之外唯一允许直接使用 `node:fs` 做文件内容搬运的地方
 * （工作目录交付物、版本快照）。原子写复用既有 `infra/file-store/fs-utils`。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

import type { FileFingerprint, FileOps } from '../../ports/file-ops.js'
import { atomicWriteFile } from '../file-store/fs-utils.js'

export class LocalFileOps implements FileOps {
  async read(absPath: string): Promise<Buffer> {
    return fs.readFile(absPath)
  }

  async readText(absPath: string): Promise<string> {
    return fs.readFile(absPath, 'utf8')
  }

  async writeText(absPath: string, text: string): Promise<void> {
    await atomicWriteFile(absPath, text)
  }

  async copy(from: string, to: string): Promise<void> {
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.copyFile(from, to)
  }

  async ensureDir(absDir: string): Promise<void> {
    await fs.mkdir(absDir, { recursive: true })
  }

  async exists(absPath: string): Promise<boolean> {
    try {
      await fs.access(absPath)
      return true
    } catch {
      return false
    }
  }

  async list(absDir: string): Promise<string[]> {
    try {
      return await fs.readdir(absDir)
    } catch {
      return []
    }
  }

  async removeDir(absDir: string): Promise<void> {
    await fs.rm(absDir, { recursive: true, force: true })
  }

  async fingerprint(absPath: string): Promise<FileFingerprint> {
    const content = await fs.readFile(absPath)
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    }
  }
}
