/**
 * 项目产出物的**署名与归属**（file-owners.jsonl，2026-09-12）。
 *
 * 模型：项目工作目录是唯一产出地；每个文件登记首个写入者（owner）与显示名（署名）。
 * 规则：
 *  - 无主文件 → 可写（写完即认领；用户既有仓库文件因此也能被角色接手）；
 *  - owner = 自己 → 可写（更新 lastAt/edits）；
 *  - owner = 他人 → **拒绝**（ERR_FORBIDDEN，消息点名 owner，并提示另建新文件）；
 *  - 不做转交（用户选择"只读 + 新建文件"）；用户本人始终可写（不经本表校验）。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { nowIso } from '../../infra/util/id.js'
import { KeyedLock } from '../../infra/util/keyed-lock.js'
import { atomicWriteFile } from '../../infra/file-store/fs-utils.js'

export type OwnershipVia = 'workdir_edit' | 'artifact_submit'

export interface FileOwnerRecord {
  /** 工作目录内相对路径（如 src/a.ts） */
  relPath: string
  /** 归属实例 id（如 dev_1） */
  owner: string
  /** 署名（角色显示名，如「开发工程师」）；团队成员改名后以最近一次写入为准 */
  ownerName: string
  firstAt: string
  lastAt: string
  /** 累计写入次数 */
  edits: number
  /** 最近一次写入归属的任务（无任务上下文为 null） */
  lastTaskId: string | null
  via: OwnershipVia
}

export interface ClaimInput {
  relPath: string
  owner: string
  ownerName?: string
  taskId?: string | null
  via: OwnershipVia
}

export class FileOwnerStore {
  private readonly lock = new KeyedLock()

  constructor(private readonly projectsRoot: string) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'file-owners.jsonl')
  }

  async readAll(projectId: string): Promise<FileOwnerRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(projectId), 'utf8')
    } catch {
      return []
    }
    const out: FileOwnerRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as FileOwnerRecord)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  /** 全部归属记录（按最近修改倒序）。 */
  async list(projectId: string): Promise<FileOwnerRecord[]> {
    const all = await this.readAll(projectId)
    return all.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
  }

  async get(projectId: string, relPath: string): Promise<FileOwnerRecord | null> {
    return (await this.readAll(projectId)).find((r) => r.relPath === relPath) ?? null
  }

  /** 我名下的产出物。 */
  async mine(projectId: string, owner: string): Promise<FileOwnerRecord[]> {
    return (await this.list(projectId)).filter((r) => r.owner === owner)
  }

  /** 他人名下的产出物（只读）。 */
  async others(projectId: string, owner: string): Promise<FileOwnerRecord[]> {
    return (await this.list(projectId)).filter((r) => r.owner !== owner)
  }

  /**
   * 写入前校验：无主放行；owner 是自己放行；他人 → ERR_FORBIDDEN。
   * 抛错消息直接面向模型/用户，说明"谁的、怎么办"。
   */
  async assertWritable(projectId: string, relPath: string, actor: string): Promise<void> {
    const rec = await this.get(projectId, relPath)
    if (!rec || rec.owner === actor) return
    const who = rec.ownerName ? `${rec.ownerName}（${rec.owner}）` : rec.owner
    throw new AppError(
      ErrorCodes.FORBIDDEN,
      `${relPath} 属 ${who} 所有，你（${actor}）不能修改他人产出物；` +
        '如需新版本，请另建新文件（例如加版本后缀），或让用户协调',
    )
  }

  /** 登记/更新归属（写入成功后调用）：首次认领或续写计数。 */
  async claim(projectId: string, input: ClaimInput): Promise<FileOwnerRecord> {
    return this.lock.run(projectId, async () => {
      const all = await this.readAll(projectId)
      const idx = all.findIndex((r) => r.relPath === input.relPath)
      const ts = nowIso()
      const prev = idx >= 0 ? all[idx]! : null
      const rec: FileOwnerRecord = {
        relPath: input.relPath,
        owner: input.owner,
        ownerName: input.ownerName ?? prev?.ownerName ?? '',
        firstAt: prev?.firstAt ?? ts,
        lastAt: ts,
        edits: (prev?.edits ?? 0) + 1,
        lastTaskId: input.taskId ?? null,
        via: input.via,
      }
      if (idx >= 0) all[idx] = rec
      else all.push(rec)
      await fs.mkdir(join(this.projectsRoot, projectId), { recursive: true })
      await atomicWriteFile(
        this.file(projectId),
        all.map((x) => JSON.stringify(x)).join('\n') + '\n',
      )
      return rec
    })
  }
}
