import type { FastifyInstance } from 'fastify'
import type { OrchestrationService } from '../../ports/orchestration'
import type { OrchestrationNode } from '../../ports/orchestration'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'
import { asRecord } from './parse'

/**
 * 编排图路由（contract.md / orchestration.md §7）：
 * - `GET /api/projects/:pid/orchestration`：读取（按当前团队归一化：补新实例节点、级联删除已移除实例的节点与边）
 * - `PUT /api/projects/:pid/orchestration`：全量保存 `{version, nodes, edges}`；版本不匹配 → `ERR_CONFLICT`
 *
 * 只有用户能编辑图（Agent 不可改图，orchestration.md §1 铁律 7）；本路由即用户入口。
 */

export interface OrchestrationRouteContext {
  readonly orchestration: OrchestrationService
}

function readNodes(raw: unknown): readonly OrchestrationNode[] | null {
  if (!Array.isArray(raw)) return null
  const nodes: OrchestrationNode[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    const instanceId = typeof record['instanceId'] === 'string' ? record['instanceId'] : ''
    if (instanceId.length === 0) return null
    nodes.push({
      instanceId,
      x: typeof record['x'] === 'number' && Number.isFinite(record['x']) ? record['x'] : 0,
      y: typeof record['y'] === 'number' && Number.isFinite(record['y']) ? record['y'] : 0,
      collapsed: record['collapsed'] === true,
    })
  }
  return nodes
}

function readEdges(raw: unknown): readonly { id?: string; from: string; to: string }[] | null {
  if (!Array.isArray(raw)) return null
  const edges: { id?: string; from: string; to: string }[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    const from = typeof record['from'] === 'string' ? record['from'] : ''
    const to = typeof record['to'] === 'string' ? record['to'] : ''
    if (from.length === 0 || to.length === 0) return null
    edges.push({
      from,
      to,
      ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    })
  }
  return edges
}

export function registerOrchestrationRoutes(app: FastifyInstance, context: OrchestrationRouteContext): void {
  const { orchestration } = context

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/orchestration', async (request, reply) =>
    replyFromResult(reply, await orchestration.get(request.params.pid)),
  )

  app.put<{ Params: { pid: string } }>('/api/projects/:pid/orchestration', async (request, reply) => {
    const body = asRecord(request.body)
    const version = body['version']
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      return replyFromResult(reply, err('ERR_VALIDATION', '缺少 version（乐观并发必填）', { field: 'version' }))
    }
    const nodes = readNodes(body['nodes'])
    if (nodes === null) {
      return replyFromResult(reply, err('ERR_VALIDATION', 'nodes 必须是 [{instanceId,x,y,collapsed?}]', { field: 'nodes' }))
    }
    const edges = readEdges(body['edges'])
    if (edges === null) {
      return replyFromResult(reply, err('ERR_VALIDATION', 'edges 必须是 [{from,to,id?}]', { field: 'edges' }))
    }
    return replyFromResult(
      reply,
      await orchestration.save({
        projectId: request.params.pid,
        expectedVersion: Math.floor(version),
        nodes,
        edges,
        updatedBy: 'user',
      }),
    )
  })
}
