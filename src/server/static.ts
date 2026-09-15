import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { sendError } from './errors'

/**
 * 前端静态资源托管 + SPA 回退。
 * 仅当 web 构建产物存在时调用（由 bootstrap 经 StaticAssetProvider 判定）。
 */
export async function registerStaticRoutes(app: FastifyInstance, distDir: string): Promise<void> {
  await app.register(fastifyStatic, { root: distDir, prefix: '/', index: ['index.html'] })

  // 非 API/WS 的未知路径交给前端路由（刷新深链接不 404）
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      void sendError(reply, { code: 'ERR_NOT_FOUND', message: `接口不存在：${request.method} ${request.url}` })
      return
    }
    return reply.sendFile('index.html')
  })
}
