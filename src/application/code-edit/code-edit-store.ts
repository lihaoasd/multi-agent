/**
 * code 受控编辑轨迹（workspaces-artifacts §2.2/D14-⑧）。
 * 每个 workdir_edit 调用记录到 runtime/<pid>/code-edits/<aggKey>.jsonl；
 * aggKey = taskId（任务级聚合）或 `untracked_<iid>`（无任务按回合兜底）。
 * 结算（任务 done/terminated）读取该轨迹 → 生成 code artifact 后清空。
 *
 * 重构 P1b（2026-09-14）：持久化改走 `ProjectStore` 门面；删除动作也由门面承担
 * （application 层不再出现 `node:fs`）。
 */
import { nowIso } from '../../shared/util/id.js'
import type { ProjectStore } from '../../infra/store/project-store.js'

export interface CodeEditEntry {
  relPath: string
  editType: 'write' | 'replace'
  changedChars: number
  ts: string
}

/** 轨迹文件的项目相对路径。 */
function editFile(aggKey: string): string {
  return `code-edits/${aggKey}.jsonl`
}

export class CodeEditStore {
  constructor(private readonly store: ProjectStore) {}

  async append(projectId: string, aggKey: string, entry: Omit<CodeEditEntry, 'ts'>): Promise<void> {
    const rec: CodeEditEntry = { ...entry, ts: nowIso() }
    await this.store.mutate<CodeEditEntry>(projectId, editFile(aggKey), (all) => [...all, rec])
  }

  async readAll(projectId: string, aggKey: string): Promise<CodeEditEntry[]> {
    return this.store.readAll<CodeEditEntry>(projectId, editFile(aggKey))
  }

  /** 涉及的 relPath（去重、保序）。 */
  async listRelPaths(projectId: string, aggKey: string): Promise<string[]> {
    const all = await this.readAll(projectId, aggKey)
    return [...new Set(all.map((e) => e.relPath))]
  }

  async clear(projectId: string, aggKey: string): Promise<void> {
    await this.store.remove(projectId, editFile(aggKey))
  }
}
