/**
 * code 受控编辑轨迹（workspaces-artifacts §2.2/D14-⑧）。
 * 每个 workdir_edit 调用记录到 runtime/<pid>/code-edits/<aggKey>.jsonl；
 * aggKey = taskId（任务级聚合）或 `untracked_<iid>`（无任务按回合兜底）。
 * 结算（任务 done/terminated）读取该轨迹 → 生成 code artifact 后清空。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { nowIso } from '../../infra/util/id.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'

export interface CodeEditEntry {
  relPath: string
  editType: 'write' | 'replace'
  changedChars: number
  ts: string
}

export class CodeEditStore {
  constructor(private readonly projectsRoot: string) {}

  private file(projectId: string, aggKey: string): string {
    return join(this.projectsRoot, projectId, 'code-edits', `${aggKey}.jsonl`)
  }

  async append(projectId: string, aggKey: string, entry: Omit<CodeEditEntry, 'ts'>): Promise<void> {
    const rec: CodeEditEntry = { ...entry, ts: nowIso() }
    const all = await this.readAll(projectId, aggKey)
    all.push(rec)
    await fs.mkdir(join(this.projectsRoot, projectId, 'code-edits'), { recursive: true })
    await atomicWriteFile(
      this.file(projectId, aggKey),
      all.map((x) => JSON.stringify(x)).join('\n') + '\n',
    )
  }

  async readAll(projectId: string, aggKey: string): Promise<CodeEditEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId, aggKey), 'utf8')
    } catch {
      return []
    }
    const out: CodeEditEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as CodeEditEntry)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  /** 涉及的 relPath（去重、保序）。 */
  async listRelPaths(projectId: string, aggKey: string): Promise<string[]> {
    const all = await this.readAll(projectId, aggKey)
    return [...new Set(all.map((e) => e.relPath))]
  }

  async clear(projectId: string, aggKey: string): Promise<void> {
    await fs.rm(this.file(projectId, aggKey), { force: true }).catch(() => undefined)
  }
}
