import type { FastifyInstance } from 'fastify'
import { APP_NAME, APP_VERSION } from '../../shared/app-info'
import type { AppConfig } from '../../shared/config'

export interface HealthRouteContext {
  readonly startedAt: number
  readonly config: AppConfig
}

/** `GET /health`：进程存活与关键配置的只读自检（不含任何密钥） */
export function registerHealthRoutes(app: FastifyInstance, context: HealthRouteContext): void {
  app.get('/health', () => ({
    status: 'ok',
    name: APP_NAME,
    version: APP_VERSION,
    uptimeMs: Date.now() - context.startedAt,
    dataDir: context.config.dataDir,
    sandboxNetwork: context.config.sandbox.network,
  }))
}
