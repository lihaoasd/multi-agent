import type { FastifyInstance } from 'fastify'
import type { LoopRegistry } from '../../application/agent-loop/loop'
import type { ToolPackageRegistry, ToolRegistry } from '../../ports/tools'
import { replyFromResult } from '../errors'
import { ok } from '../../shared/result'

export interface ToolRouteContext {
  readonly tools: ToolRegistry
  readonly packages: ToolPackageRegistry
  readonly loops: LoopRegistry
}

/**
 * 工具与 loop 的只读展示（D19-②：MVP 只展示，不可制作/卸载）。
 * 展示态 vs 生效态的区分：`registered` 表示该工具在当前版本**确实注册且可用**。
 */
export function registerToolRoutes(app: FastifyInstance, context: ToolRouteContext): void {
  app.get('/api/tool-packages', async (_request, reply) => {
    const registered = new Set(context.tools.list().map((tool) => tool.name))
    return replyFromResult(
      reply,
      ok(
        context.packages.list().map((item) => ({
          ...item,
          tools: item.tools.map((name) => ({ name, registered: registered.has(name) })),
        })),
      ),
    )
  })

  app.get<{ Params: { packageId: string } }>('/api/tool-packages/:packageId', async (request, reply) => {
    const item = context.packages.get(request.params.packageId)
    if (item === undefined) {
      return replyFromResult(reply, {
        ok: false,
        error: { code: 'ERR_NOT_FOUND', message: `工具包不存在：${request.params.packageId}` },
      })
    }
    const definitions = new Map(context.tools.list().map((tool) => [tool.name, tool]))
    return replyFromResult(
      reply,
      ok({
        ...item,
        tools: item.tools.map((name) => {
          const definition = definitions.get(name)
          return {
            name,
            registered: definition !== undefined,
            ...(definition === undefined
              ? {}
              : {
                  description: definition.description,
                  risk: definition.risk,
                  network: definition.network,
                  idempotent: definition.idempotent,
                  availableIn: definition.availableIn,
                }),
          }
        }),
      }),
    )
  })

  app.get('/api/tools', async (_request, reply) =>
    replyFromResult(
      reply,
      ok(
        context.tools.list().map((tool) => ({
          name: tool.name,
          package: tool.package,
          description: tool.description,
          risk: tool.risk,
          network: tool.network,
          needsApproval: tool.needsApproval === true,
          idempotent: tool.idempotent,
          availableIn: tool.availableIn,
        })),
      ),
    ),
  )

  app.get('/api/loops', async (_request, reply) => replyFromResult(reply, ok(context.loops.list())))
}
