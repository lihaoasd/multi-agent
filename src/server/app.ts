import Fastify, { type FastifyInstance } from 'fastify'
import type { Logger } from '../ports/logger'
import type { StaticAssetProvider } from '../ports/static-assets'
import type { AppConfig } from '../shared/config'
import { registerErrorHandler, registerJsonNotFoundHandler } from './errors'
import { registerHealthRoutes } from './http-routes/health'
import { registerStaticRoutes } from './static'

export interface CreateServerOptions {
  readonly config: AppConfig
  readonly logger: Logger
  readonly staticAssets: StaticAssetProvider
}

/**
 * HTTP/WS 服务装配（server 层只依赖 application/ports/shared）。
 * 说明：Fastify 自带日志关闭，使用平台结构化 Logger（先盘后推/审计链路由后续阶段接入）。
 */
export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const distDir = options.staticAssets.distDir()
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  })

  registerErrorHandler(app, {
    onInternalError: (error, appError) => {
      options.logger.error('请求处理失败', {
        code: appError.code,
        message: appError.message,
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
  })
  registerHealthRoutes(app, { startedAt: Date.now(), config: options.config })

  if (distDir !== null) {
    await registerStaticRoutes(app, distDir)
  } else {
    registerJsonNotFoundHandler(app)
  }

  return app
}
