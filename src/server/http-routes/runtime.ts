import type { FastifyInstance } from 'fastify'
import type { RuntimeService, ProjectExporter } from '../../ports/runtime'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'
import { asRecord, readString } from './parse'

/**
 * 运行控制与导出路由（contract.md / agent-runtime.md §7）：
 * - `GET  /api/projects/:pid/runtime`：运行细条（n 个 Agent 正在工作 + 队列 + 暂停数）
 * - `POST /api/projects/:pid/agents/:iid/stop`：`{scope:'turn'|'task'}`（停当前回合输出 / 终止当前任务并结算快照）
 * - `GET  /api/projects/:pid/export`：导出运行时项目文件夹为 zip
 *
 * ⚠️ S21/D27（2026-09-16）：`/recovery` 三条路由已删除——未完成回合不再由平台判定，
 * 改由 Agent 自查会话事件（工具 `session_recent`）判断并自行用 `ask_user` 询问用户。
 */

export interface RuntimeRouteContext {
  readonly runtime: RuntimeService
  readonly exporter: ProjectExporter
}

export function registerRuntimeRoutes(app: FastifyInstance, context: RuntimeRouteContext): void {
  const { runtime, exporter } = context

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/runtime', async (request, reply) =>
    replyFromResult(reply, await runtime.snapshot(request.params.pid)),
  )

  app.post<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/agents/:iid/stop', async (request, reply) => {
    const body = asRecord(request.body)
    const scope = readString(body, 'scope') ?? 'turn'
    if (scope !== 'turn' && scope !== 'task') {
      return replyFromResult(reply, err('ERR_VALIDATION', `scope 必须是 turn 或 task（收到 ${scope}）`, { field: 'scope' }))
    }
    return replyFromResult(
      reply,
      await runtime.stop({ projectId: request.params.pid, instanceId: request.params.iid, scope }),
    )
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/export', async (request, reply) => {
    const exported = await exporter.export(request.params.pid)
    if (!exported.ok) return replyFromResult(reply, exported)
    return reply
      .code(200)
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${exported.value.fileName}"`)
      .send(exported.value.content)
  })
}
