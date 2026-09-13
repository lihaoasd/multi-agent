/**
 * HTTP 服务组装（Fastify）：REST + WS + 统一错误映射。
 * 错误响应体统一 { code, message }（api/contract.md §1）。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'

import { ErrorCodes, isAppError } from '../shared/errors.js'
import type { Services } from '../application/composition.js'
import {
  registerApprovalRoutes,
  registerArtifactRoutes,
  registerAttentionRoute,
  registerBrowseRoutes,
  registerConfigRoutes,
  registerExportRoutes,
  registerMeetingRoutes,
  registerMemorySearchRoutes,
  registerProjectRoutes,
  registerQuestionRoutes,
  registerRoleRoutes,
  registerSessionRoutes,
  registerTaskRoutes,
  registerTeamRoutes,
  registerWs,
} from './routes.js'

/** 组装应用（不监听端口，便于测试注入）。webDir 提供时一并托管前端静态资源。 */
export async function buildApp(
  svc: Services,
  opts: { webDir?: string } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  if (opts.webDir) {
    // 前端静态资源：no-cache 强制浏览器每次校验（避免旧 app.js 被缓存住）。
    // 注意 @fastify/static v10 的 setHeaders 回传 **FastifyReply**（用 reply.header()），
    // 不是原生 ServerResponse（那才用 res.setHeader()）——用错会在请求时抛 TypeError。
    await app.register(fastifyStatic, {
      root: opts.webDir,
      prefix: '/',
      setHeaders: (reply) => {
        reply.header('Cache-Control', 'no-cache')
      },
    })
    app.get('/', async (_req, reply) => reply.sendFile('index.html'))
  }

  app.setErrorHandler((err, _req, reply) => {
    if (isAppError(err)) {
      void reply.code(err.httpStatus).send({ code: err.code, message: err.message })
      return
    }
    const fastifyErr = err as FastifyError
    if (fastifyErr.validation) {
      void reply
        .code(400)
        .send({ code: ErrorCodes.VALIDATION, message: fastifyErr.message ?? '参数校验失败' })
      return
    }
    void reply.code(500).send({ code: ErrorCodes.INTERNAL, message: '内部错误' })
  })
  registerProjectRoutes(app, svc)
  registerTeamRoutes(app, svc)
  registerRoleRoutes(app, svc)
  registerSessionRoutes(app, svc)
  registerApprovalRoutes(app, svc)
  registerArtifactRoutes(app, svc)
  registerMemorySearchRoutes(app, svc)
  registerMeetingRoutes(app, svc)
  registerTaskRoutes(app, svc)
  registerQuestionRoutes(app, svc)
  registerAttentionRoute(app, svc)
  registerExportRoutes(app, svc)
  registerBrowseRoutes(app)
  registerConfigRoutes(app, svc)
  registerWs(app, svc)
  return app
}
