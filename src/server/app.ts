import Fastify, { type FastifyInstance } from 'fastify'
import type { ModelConfigService } from '../application/model-config/service'
import type { ProjectService } from '../application/project/service'
import type { AgentConfigService } from '../application/team/agent-config-service'
import type { TeamService } from '../application/team/team-service'
import type { EventBroadcaster } from '../ports/events'
import type { Logger } from '../ports/logger'
import type { StaticAssetProvider } from '../ports/static-assets'
import type { AppConfig } from '../shared/config'
import { registerErrorHandler, registerJsonNotFoundHandler } from './errors'
import { registerAgentTemplateRoutes } from './http-routes/agent-templates'
import { registerHealthRoutes } from './http-routes/health'
import { registerModelConfigRoutes } from './http-routes/model-config'
import { registerProjectRoutes } from './http-routes/projects'
import { registerStaticRoutes } from './static'

export interface ServerServices {
  readonly modelConfig: ModelConfigService
  readonly agentConfig: AgentConfigService
  readonly project: ProjectService
  readonly team: TeamService
  readonly broadcaster: EventBroadcaster
}

export interface CreateServerOptions {
  readonly config: AppConfig
  readonly logger: Logger
  readonly staticAssets: StaticAssetProvider
  readonly services: ServerServices
}

/**
 * HTTP 服务装配（server 层只依赖 application / ports / shared）。
 * Fastify 自带日志关闭，统一用平台结构化 Logger（审计与先盘后推在后续阶段接入）。
 */
export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const distDir = options.staticAssets.distDir()
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  })

  // 空 body + JSON content-type（无 body 的 POST 会被部分客户端这么发）视为 `{}`；
  // 否则 Fastify 抛 FST_ERR_CTP_EMPTY_JSON_BODY，把无参数的启用/停用接口打成 500。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (text.trim().length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch (cause) {
      done(cause instanceof Error ? cause : new Error(String(cause)))
    }
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
  registerModelConfigRoutes(app, {
    service: options.services.modelConfig,
    broadcaster: options.services.broadcaster,
  })
  registerAgentTemplateRoutes(app, {
    service: options.services.agentConfig,
    broadcaster: options.services.broadcaster,
  })
  registerProjectRoutes(app, {
    project: options.services.project,
    team: options.services.team,
    broadcaster: options.services.broadcaster,
  })

  if (distDir !== null) {
    await registerStaticRoutes(app, distDir)
  } else {
    registerJsonNotFoundHandler(app)
  }

  return app
}
