import type { Clock } from '../../ports/clock'
import type { FileStore, RelPath } from '../../ports/file-store'
import type { LockManager } from '../../ports/lock'
import type { OrchestrationEdge, OrchestrationGraph, OrchestrationNode, OrchestrationStore } from '../../ports/orchestration'
import type { ProjectId } from '../../ports/project'
import { ok } from '../../shared/result'

export interface OrchestrationStoreOptions {
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly clock: Clock
  readonly dataDir: RelPath
}

function parseGraph(projectId: ProjectId, raw: unknown): OrchestrationGraph | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const nodes: OrchestrationNode[] = Array.isArray(record['nodes'])
    ? record['nodes']
        .map((item): OrchestrationNode | null => {
          if (typeof item !== 'object' || item === null) return null
          const node = item as Record<string, unknown>
          const instanceId = typeof node['instanceId'] === 'string' ? node['instanceId'] : ''
          if (instanceId.length === 0) return null
          return {
            instanceId,
            x: Number(node['x'] ?? 0) || 0,
            y: Number(node['y'] ?? 0) || 0,
            collapsed: node['collapsed'] === true,
          }
        })
        .filter((item): item is OrchestrationNode => item !== null)
    : []
  const edges: OrchestrationEdge[] = Array.isArray(record['edges'])
    ? record['edges']
        .map((item): OrchestrationEdge | null => {
          if (typeof item !== 'object' || item === null) return null
          const edge = item as Record<string, unknown>
          const id = typeof edge['id'] === 'string' ? edge['id'] : ''
          const from = typeof edge['from'] === 'string' ? edge['from'] : ''
          const to = typeof edge['to'] === 'string' ? edge['to'] : ''
          if (id.length === 0 || from.length === 0 || to.length === 0) return null
          return { id, from, to, createdAt: typeof edge['createdAt'] === 'string' ? edge['createdAt'] : '' }
        })
        .filter((item): item is OrchestrationEdge => item !== null)
    : []
  return {
    schemaVersion: 1,
    projectId,
    version: Number(record['version'] ?? 1) || 1,
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
    updatedBy: typeof record['updatedBy'] === 'string' ? record['updatedBy'] : 'user',
    nodes,
    edges,
  }
}

/** 编排图存储（`projects/<pid>/orchestration.json`，原子写 + 单项目串行锁） */
export function createOrchestrationStore(options: OrchestrationStoreOptions): OrchestrationStore {
  const pathFor = (projectId: ProjectId): RelPath => `${options.dataDir}/projects/${projectId}/orchestration.json`

  const emptyGraph = (projectId: ProjectId): OrchestrationGraph => ({
    schemaVersion: 1,
    projectId,
    version: 0,
    updatedAt: '',
    updatedBy: 'user',
    nodes: [],
    edges: [],
  })

  return {
    async load(projectId) {
      const text = await options.fileStore.readText(pathFor(projectId))
      if (!text.ok) return ok(emptyGraph(projectId))
      try {
        const parsed = parseGraph(projectId, JSON.parse(text.value))
        return ok(parsed ?? emptyGraph(projectId))
      } catch {
        // 损坏 → 视为空图（业务记录文件可重建；画布上的坐标属派生展示数据）
        return ok(emptyGraph(projectId))
      }
    },

    async save(projectId, graph) {
      return options.lock.withLock(`orchestration:${projectId}`, async () => {
        const written = await options.fileStore.writeJsonAtomic(pathFor(projectId), graph)
        return written.ok ? ok(graph) : written
      })
    },
  }
}
