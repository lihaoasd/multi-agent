/**
 * HTTP 服务组装（Fastify）：REST 路由 + 统一错误映射。
 * 错误响应体统一 { code, message }（api/contract.md §1）；状态码仅粗分类。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'

import { ErrorCodes, isAppError } from '../shared/errors.js'
import type { PlatformConfig } from '../shared/config.js'
import { ProjectService } from '../application/project/project-service.js'
import { browseDirectory } from '../application/fs-browse/fs-browse-service.js'
import { RoleService } from '../application/roles/role-service.js'
import {
  TeamService,
  type TeamAddInput,
  type TeamPatchInput,
} from '../application/team/team-service.js'
import type { RoleTemplate } from '../shared/types/role.js'

export interface ServerDeps {
  config: PlatformConfig
  projectService: ProjectService
  roleService: RoleService
  teamService: TeamService
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

  registerProjectRoutes(app, deps)
  registerTeamRoutes(app, deps)
  registerRoleRoutes(app, deps.roleService)
  registerBrowseRoutes(app)
  registerConfigRoutes(app, deps.config)
  return app
}

interface CreateProjectBody {
  name?: string
  description?: string
  workdir?: string
  /** M1 创建向导：可选一次性组队（勾选角色）。 */
  team?: TeamAddInput[]
}

function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { projectService, teamService } = deps

  app.get('/api/projects', async () => ({ projects: await projectService.list() }))

  app.post<{ Body: CreateProjectBody }>('/api/projects', async (req, reply) => {
    const body = req.body ?? {}
    if (typeof body.name !== 'string' || typeof body.workdir !== 'string') {
      return reply
        .code(400)
        .send({ code: ErrorCodes.VALIDATION, message: 'name 与 workdir 为必填字符串' })
    }
    const project = await projectService.create({
      name: body.name,
      description: typeof body.description === 'string' ? body.description : undefined,
      workdir: body.workdir,
    })
    // 向导可选组队：失败则回滚已建项目，保持原子语义
    if (Array.isArray(body.team) && body.team.length > 0) {
      try {
        for (const t of body.team) await teamService.add(project.id, t)
      } catch (err) {
        await projectService.remove(project.id).catch(() => undefined)
        throw err
      }
    }
    const final = await projectService.get(project.id)
    return reply.code(201).send({ project: final })
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid', async (req) => {
    return { project: await projectService.get(req.params.pid) }
  })

  app.patch<{
    Params: { pid: string }
    Body: { name?: string; description?: string }
  }>('/api/projects/:pid', async (req) => {
    return { project: await projectService.patch(req.params.pid, req.body ?? {}) }
  })

  app.delete<{ Params: { pid: string }; Querystring: { force?: string } }>(
    '/api/projects/:pid',
    async (req, reply) => {
      void req.query
      await projectService.remove(req.params.pid)
      return reply.code(204).send()
    },
  )
}

function registerTeamRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { teamService } = deps

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/team', async (req) => ({
    team: await teamService.list(req.params.pid),
  }))

  app.post<{ Params: { pid: string }; Body: TeamAddInput }>(
    '/api/projects/:pid/team',
    async (req, reply) => {
      const member = await teamService.add(req.params.pid, req.body ?? {})
      return reply.code(201).send({ member })
    },
  )

  app.patch<{
    Params: { pid: string; iid: string }
    Body: TeamPatchInput
  }>('/api/projects/:pid/team/:iid', async (req) => {
    return { member: await teamService.patch(req.params.pid, req.params.iid, req.body ?? {}) }
  })

  // DELETE /team/:iid = 停用实例（保留数据可重新启用，D14-9）
  app.delete<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/team/:iid',
    async (req, reply) => {
      await teamService.disable(req.params.pid, req.params.iid)
      return reply.code(204).send()
    },
  )
}

interface RoleBody {
  roleId?: string
  name?: string
  category?: string
  description?: string
  systemPrompt?: string
  defaultModel?: string
  defaultLoop?: RoleTemplate['defaultLoop']
  tools?: string[]
  artifactTypes?: string[]
  defaultApprovalRules?: Record<string, unknown>
}

function registerRoleRoutes(app: FastifyInstance, svc: RoleService): void {
  app.get('/api/roles', async () => ({ roles: await svc.list() }))

  app.post<{ Body: RoleBody }>('/api/roles', async (req, reply) => {
    const b = req.body ?? {}
    const created = await svc.create(b as Omit<RoleTemplate, 'source' | 'createdAt' | 'updatedAt'>)
    return reply.code(201).send({ role: created })
  })

  app.patch<{ Params: { roleId: string }; Body: RoleBody }>('/api/roles/:roleId', async (req) => {
    const b = req.body ?? {}
    const { roleId, ...patch } = b as RoleBody
    void roleId
    return { role: await svc.update(req.params.roleId, patch) }
  })

  app.delete<{ Params: { roleId: string } }>('/api/roles/:roleId', async (req, reply) => {
    await svc.remove(req.params.roleId)
    return reply.code(204).send()
  })
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
