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

  /**
   * `GET /api/config`：运行期只读总览（contract.md §系统）——
   * 配置默认值、上下文上限、存储根；**模型与供应商部分已迁出**（见 `/api/model-*`），且**永不含密钥**。
   */
  app.get('/api/config', () => ({
    name: APP_NAME,
    version: APP_VERSION,
    storage: { dataDir: context.config.dataDir, roleDirs: context.config.roleDirs },
    server: { host: context.config.server.host, port: context.config.server.port },
    models: {
      configFile: context.config.models.configFile,
      importFromEnv: context.config.models.importFromEnv,
      maxPromptChars: context.config.models.maxPromptChars,
      requestTimeoutMs: context.config.models.requestTimeoutMs,
    },
    approval: context.config.approval,
    sandbox: context.config.sandbox,
    search: context.config.search,
    context: context.config.context,
    // 迁移/备份与损坏恢复口径（data-storage.md §9）
    backup: { projectDir: 'data/projects/<projectId>/', workdirIncluded: false },
  }))
}
