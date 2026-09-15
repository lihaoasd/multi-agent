import type { Clock } from '../../ports/clock'
import type { EventBroadcaster } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { Logger } from '../../ports/logger'
import type {
  OrchestrationEdge,
  OrchestrationGraph,
  OrchestrationNode,
  OrchestrationService,
  OrchestrationStore,
  SaveOrchestrationInput,
} from '../../ports/orchestration'
import type { InstanceId, ProjectId, ProjectStore } from '../../ports/project'
import { err, ok, type Result } from '../../shared/result'

/**
 * 编排图用例（orchestration.md §1/§3）：
 * - 节点必须是本项目实例（跨项目/未知实例 → `ERR_ORCHESTRATION_INVALID`）；
 * - 边：无自环、无重复（`from+to` 唯一）、两端都在图中 → 否则 `ERR_ORCHESTRATION_INVALID`；
 * - 全量保存 + `version` 乐观并发：`expectedVersion` 不匹配 → `ERR_CONFLICT`（提示刷新重试）；
 * - 保存成功广播 `orchestration.updated`；**委派只能沿出边**（`canDelegate`，铁律 2）。
 */

export interface OrchestrationServiceOptions {
  readonly store: OrchestrationStore
  readonly projects: ProjectStore
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly broadcaster: EventBroadcaster
  readonly logger: Logger
}

/** 新节点的默认摆放：网格铺开（画布坐标只服务呈现，无调度语义） */
const GRID = { originX: 80, originY: 60, stepX: 260, stepY: 160, perRow: 3 } as const

export function createOrchestrationService(options: OrchestrationServiceOptions): OrchestrationService {
  const { store, projects, ids, clock, broadcaster } = options

  /** 读取并按当前团队归一化：补新实例节点、级联删除已移除实例的节点与边 */
  const normalize = async (projectId: ProjectId): Promise<Result<OrchestrationGraph>> => {
    const project = await projects.get(projectId)
    if (!project.ok) return project
    const loaded = await store.load(projectId)
    if (!loaded.ok) return loaded

    const team = project.value.team.map((item) => item.instanceId)
    const teamSet = new Set(team)
    const known = new Map(loaded.value.nodes.map((node) => [node.instanceId, node]))
    const nodes: OrchestrationNode[] = []
    team.forEach((instanceId, index) => {
      const existing = known.get(instanceId)
      if (existing !== undefined) {
        nodes.push(existing)
        return
      }
      nodes.push({
        instanceId,
        x: GRID.originX + (index % GRID.perRow) * GRID.stepX,
        y: GRID.originY + Math.floor(index / GRID.perRow) * GRID.stepY,
        collapsed: false,
      })
    })

    const edges = loaded.value.edges
      .filter((edge) => teamSet.has(edge.from) && teamSet.has(edge.to) && edge.from !== edge.to)
      .filter((edge, index, all) => all.findIndex((item) => item.from === edge.from && item.to === edge.to) === index)

    return ok({ ...loaded.value, projectId, nodes, edges })
  }

  const validate = (input: SaveOrchestrationInput, team: readonly InstanceId[]): Result<void> => {
    const teamSet = new Set(team)
    const nodeIds = new Set<string>()
    for (const node of input.nodes) {
      if (!teamSet.has(node.instanceId)) {
        return err('ERR_ORCHESTRATION_INVALID', `节点不是本项目实例：${node.instanceId}`, {
          instanceId: node.instanceId,
        })
      }
      if (nodeIds.has(node.instanceId)) {
        return err('ERR_ORCHESTRATION_INVALID', `节点重复：${node.instanceId}`, { instanceId: node.instanceId })
      }
      nodeIds.add(node.instanceId)
    }
    const seen = new Set<string>()
    for (const edge of input.edges) {
      if (edge.from === edge.to) {
        return err('ERR_ORCHESTRATION_INVALID', `不允许自环：${edge.from}`, { from: edge.from, to: edge.to })
      }
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        return err('ERR_ORCHESTRATION_INVALID', `边两端必须都在图中：${edge.from} → ${edge.to}`, {
          from: edge.from,
          to: edge.to,
        })
      }
      const key = `${edge.from}->${edge.to}`
      if (seen.has(key)) {
        return err('ERR_ORCHESTRATION_INVALID', `重复边：${edge.from} → ${edge.to}`, {
          from: edge.from,
          to: edge.to,
        })
      }
      seen.add(key)
    }
    return ok(undefined)
  }

  return {
    get: normalize,

    async save(input) {
      const project = await projects.get(input.projectId)
      if (!project.ok) return project
      const team = project.value.team.map((item) => item.instanceId)
      const checked = validate(input, team)
      if (!checked.ok) return checked

      const current = await normalize(input.projectId)
      if (!current.ok) return current
      if (input.expectedVersion !== current.value.version) {
        return err('ERR_CONFLICT', '编排图已被其它页面修改，请刷新后重试', {
          expectedVersion: input.expectedVersion,
          currentVersion: current.value.version,
        })
      }

      const nowIso = clock.now().toISOString()
      const edges: OrchestrationEdge[] = input.edges.map((edge) => {
        const existing = current.value.edges.find((item) => item.from === edge.from && item.to === edge.to)
        return {
          id: edge.id ?? existing?.id ?? ids.next('e'),
          from: edge.from,
          to: edge.to,
          createdAt: existing?.createdAt ?? nowIso,
        }
      })
      const graph: OrchestrationGraph = {
        schemaVersion: 1,
        projectId: input.projectId,
        version: current.value.version + 1,
        updatedAt: nowIso,
        updatedBy: input.updatedBy ?? 'user',
        nodes: input.nodes,
        edges,
      }
      const saved = await store.save(input.projectId, graph)
      if (!saved.ok) return saved
      broadcaster.broadcast({
        type: 'orchestration.updated',
        payload: { projectId: input.projectId, graph: saved.value },
      })
      options.logger.info('编排图已保存', {
        projectId: input.projectId,
        version: saved.value.version,
        nodes: saved.value.nodes.length,
        edges: saved.value.edges.length,
      })
      return saved
    },

    async outgoingOf(projectId, from) {
      const graph = await normalize(projectId)
      if (!graph.ok) return graph
      return ok(graph.value.edges.filter((edge) => edge.from === from).map((edge) => edge.to))
    },

    async canDelegate(projectId, from, to) {
      const outgoing = await normalize(projectId)
      if (!outgoing.ok) return outgoing
      return ok(outgoing.value.edges.some((edge) => edge.from === from && edge.to === to))
    },
  }
}
