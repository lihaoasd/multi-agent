/**
 * 记忆存储（M5 L3 层）：memories/global.jsonl（项目共享）与 memories/<iid>.jsonl（角色个人）。
 * data-storage §5 / memory.md §4：条目 active/superseded 不物理删；全局写入受限（引擎/决策登记）。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { genId, nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'

export const MEMORY_TYPES = [
  'fact',
  'decision',
  'preference',
  'commitment',
  'requirement',
  'progress',
  'meeting_summary',
  'artifact_index',
] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryEntry {
  id: string
  ts: string
  type: MemoryType
  content: string
  source: { sessionId: string | null; seq: number | null }
  tags: string[]
  refs: string[]
  state: 'active' | 'superseded'
  supersededBy?: string
}

export class MemoryStore {
  constructor(private readonly projectsRoot: string) {}

  private globalFile(projectId: string): string {
    return join(this.projectsRoot, projectId, 'memories', 'global.jsonl')
  }

  private roleFile(projectId: string, instanceId: string): string {
    return join(this.projectsRoot, projectId, 'memories', `${instanceId}.jsonl`)
  }

  /** 追加条目（原子写整表；MVP 小文件可接受）。 */
  async append(
    projectId: string,
    input: Omit<MemoryEntry, 'id' | 'ts' | 'state'>,
    scope: 'global' | 'role',
    instanceId?: string,
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      ...input,
      id: genId('mem_'),
      ts: nowIso(),
      state: 'active',
    }
    const file =
      scope === 'global' ? this.globalFile(projectId) : this.roleFile(projectId, instanceId ?? '')
    const all = await this.readAll(file)
    all.push(entry)
    await this.writeAll(file, all)
    return entry
  }

  /** 作废条目（保留原行 + state=superseded/supersededBy，不物理删）。 */
  async supersede(
    projectId: string,
    entryId: string,
    byEntryId: string,
    scope: 'global' | 'role',
    instanceId?: string,
  ): Promise<void> {
    const file =
      scope === 'global' ? this.globalFile(projectId) : this.roleFile(projectId, instanceId ?? '')
    const all = await this.readAll(file)
    const e = all.find((x) => x.id === entryId)
    if (e) {
      e.state = 'superseded'
      e.supersededBy = byEntryId
      await this.writeAll(file, all)
    }
  }

  async listActive(
    projectId: string,
    opts: {
      scope?: 'global' | 'role'
      instanceId?: string
      type?: MemoryType
      limit?: number
    } = {},
  ): Promise<MemoryEntry[]> {
    const files: string[] = []
    if (opts.scope !== 'role') files.push(this.globalFile(projectId))
    if (opts.scope !== 'global' && opts.instanceId)
      files.push(this.roleFile(projectId, opts.instanceId))
    const out: MemoryEntry[] = []
    for (const f of files) {
      for (const e of await this.readAll(f)) {
        if (e.state !== 'active') continue
        if (opts.type && e.type !== opts.type) continue
        out.push(e)
      }
    }
    const limit = opts.limit ?? 50
    return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit)
  }

  private async readAll(file: string): Promise<MemoryEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return []
    }
    const out: MemoryEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as MemoryEntry)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  private async writeAll(file: string, entries: MemoryEntry[]): Promise<void> {
    await fs.mkdir(join(file, '..'), { recursive: true })
    await atomicWriteFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
}
