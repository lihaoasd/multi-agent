import type { FastifyInstance } from 'fastify'
import type { RecoveryService, RuntimeService, ProjectExporter } from '../../ports/runtime'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'
import { asRecord, readString } from './parse'

/**
 * 运行控制与恢复路由（contract.md / agent-runtime.md §7）：
 * - `GET  /api/projects/:pid/runtime`：顶部细条（n 个 Agent 正在工作 + 队列 + 暂停数）
 * - `POST /api/projects/:pid/agents/:iid/stop`：`{scope:'turn'|'task'}`（停当前回合输出 / 终止当前任务并结算快照）
 * - `GET  /api/projects/:pid/recovery`：项目内未完成回合（缺 turn_end）
 * - `GET  /api/projects/:pid/sessions/:sid/recovery`：该会话未完成回合
 * - `POST /api/projects/:pid/sessions/:sid/recovery`：三选 + 补全 `{turn, action}`
 * - `GET  /api/projects/:pid/export`：导出运行时项目文件夹为 zip
 */

export interface RuntimeRouteContext {
  readonly runtime: RuntimeService
  readonly recovery: RecoveryService
  readonly exporter: ProjectExporter
}

const ACTIONS = ['report', 'continue', 'ignore', 'complete'] as const

export function registerRuntimeRoutes(app: FastifyInstance, context: RuntimeRouteContext): void {
  const { runtime, recovery, exporter } = context

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

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/recovery', async (request, reply) =>
    replyFromResult(reply, await recovery.listUnfinished(request.params.pid)),
  )

  app.get<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/sessions/:sid/recovery',
    async (request, reply) =>
      replyFromResult(reply, await recovery.unfinished(request.params.pid, request.params.sid)),
  )

  app.post<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/sessions/:sid/recovery',
    async (request, reply) => {
      const body = asRecord(request.body)
      const action = readString(body, 'action')
      const turn = body['turn']
      if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) {
        return replyFromResult(
          reply,
          err('ERR_VALIDATION', `action 必须是 ${ACTIONS.join('/')}`, { field: 'action', allowed: ACTIONS }),
        )
      }
      if (typeof turn !== 'number' || !Number.isFinite(turn)) {
        return replyFromResult(reply, err('ERR_VALIDATION', '缺少 turn', { field: 'turn' }))
      }
      return replyFromResult(
        reply,
        await recovery.resolve({
          projectId: request.params.pid,
          sessionId: request.params.sid,
          turn: Math.floor(turn),
          action: action as (typeof ACTIONS)[number],
        }),
      )
    },
  )

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
