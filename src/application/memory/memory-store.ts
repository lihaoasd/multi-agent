/**
 * 记忆存储（M5 L3 层）：memories/global.jsonl（项目共享）与 memories/<iid>.jsonl（角色个人）。
 * data-storage §5 / memory.md §4：条目 active/superseded 不物理删；全局写入受限（引擎/决策登记）。
 *
 * 重构 P1（2026-09-14）：持久化改走 `ProjectStore` 门面（`infra/store`），本文件不再直接触碰 fs。
 */
import { genId, nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'

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

/** 记忆文件的项目相对路径。 */
function memoryFile(scope: 'global' | 'role', instanceId?: string): string {
  return scope === 'global' ? 'memories/global.jsonl' : `memories/${instanceId ?? ''}.jsonl`
}

export class MemoryStore {
  constructor(private readonly store: ProjectStore) {}

  /**
   * 追加条目（原子写整表；MVP 小文件可接受）。
   *
   * `projectId` 在 P1 重构后已不参与寻址（作用域由注入的门面决定），
   * 保留参数是为了不让调用方签名发生变化——清理它属于 P3 的遗留项（见 P1 修改记录）。
   */
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
    await this.store.mutate<MemoryEntry>(projectId, memoryFile(scope, instanceId), (all) => [
      ...all,
      entry,
    ])
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
    await this.store.mutate<MemoryEntry>(projectId, memoryFile(scope, instanceId), (all) => {
      const e = all.find((x) => x.id === entryId)
      if (!e) return null
      e.state = 'superseded'
      e.supersededBy = byEntryId
      return all
    })
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
    if (opts.scope !== 'role') files.push(memoryFile('global'))
    if (opts.scope !== 'global' && opts.instanceId) files.push(memoryFile('role', opts.instanceId))
    const out: MemoryEntry[] = []
    for (const f of files) {
      for (const e of await this.store.readAll<MemoryEntry>(projectId, f)) {
        if (e.state !== 'active') continue
        if (opts.type && e.type !== opts.type) continue
        out.push(e)
      }
    }
    const limit = opts.limit ?? 50
    return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit)
  }
}
