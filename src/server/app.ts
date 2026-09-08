/**
 * HTTP 服务组装（Fastify）：REST 路由 + 统一错误映射。
 * 错误响应体统一 { code, message }（api/contract.md §1）；状态码仅粗分类。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'

import { ErrorCodes, isAppError } from '../shared/errors.js'
import type { PlatformConfig } from '../shared/config.js'
import { ProjectService } from '../application/project/project-service.js'
import { browseDirectory } from '../application/fs-browse/fs-browse-service.js'

export interface ServerDeps {
  config: PlatformConfig
  projectService: ProjectService
}

/** 组装应用（不监听端口，便于测试注入）。 */
export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

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

  registerProjectRoutes(app, deps.projectService)
  registerBrowseRoutes(app)
  registerConfigRoutes(app, deps.config)
  return app
}

function registerProjectRoutes(app: FastifyInstance, svc: ProjectService): void {
  // GET /api/projects
  app.get('/api/projects', async () => ({ projects: await svc.list() }))

  // POST /api/projects  body:{name, description?, workdir}
  app.post<{ Body: { name: string; description?: string; workdir: string } }>(
    '/api/projects',
    async (req, reply) => {
      const body = req.body ?? {}
      if (typeof body.name !== 'string' || typeof body.workdir !== 'string') {
        return reply
          .code(400)
          .send({ code: 'ERR_VALIDATION', message: 'name 与 workdir 为必填字符串' })
      }
      const project = await svc.create({
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined,
        workdir: body.workdir,
      })
      return reply.code(201).send({ project })
    },
  )

  // GET /api/projects/:pid
  app.get<{ Params: { pid: string } }>('/api/projects/:pid', async (req) => {
    return { project: await svc.get(req.params.pid) }
  })

  // PATCH /api/projects/:pid  body:{name?, description?}
  app.patch<{
    Params: { pid: string }
    Body: { name?: string; description?: string }
  }>('/api/projects/:pid', async (req) => {
    return { project: await svc.patch(req.params.pid, req.body ?? {}) }
  })

  // DELETE /api/projects/:pid  ?force=true 保留未来强制语义（当前无运行中占用拦截）
  app.delete<{ Params: { pid: string }; Querystring: { force?: string } }>(
    '/api/projects/:pid',
    async (req, reply) => {
      void req.query
      await svc.remove(req.params.pid)
      return reply.code(204).send()
    },
  )
}

function registerBrowseRoutes(app: FastifyInstance): void {
  // GET /api/fs/browse?path=&depth=&includeHidden=
  app.get<{ Querystring: { path?: string; depth?: string; includeHidden?: string } }>(
    '/api/fs/browse',
    async (req) => {
      const path = req.query.path ?? ''
      const result = await browseDirectory({
        path,
        depth: req.query.depth !== undefined ? Number(req.query.depth) : 0,
        includeHidden: req.query.includeHidden === 'true',
      })
      return result
    },
  )
}

function registerConfigRoutes(app: FastifyInstance, config: PlatformConfig): void {
  // GET /api/config —— 只读展示模型/Provider/策略（无密钥信息）
  app.get('/api/config', async () => ({
    server: config.server,
    models: {
      default: config.models.default,
      providers: config.models.providers.map((p) => ({ ...p, apiKeyEnv: undefined })),
    },
    approval: config.approval,
    sandbox: config.sandbox,
    task: config.task,
    search: config.search,
    context: config.context,
  }))
}
