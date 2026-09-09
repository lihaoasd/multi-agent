/**
 * HTTP 服务组装（Fastify）：REST + WS + 统一错误映射。
 * 错误响应体统一 { code, message }（api/contract.md §1）。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'

import { ErrorCodes, isAppError } from '../shared/errors.js'
import { browseDirectory } from '../application/fs-browse/fs-browse-service.js'
import type { RoleTemplate } from '../shared/types/role.js'
import type { Services } from '../application/composition.js'
import type { TeamAddInput, TeamPatchInput } from '../application/team/team-service.js'

/** 组装应用（不监听端口，便于测试注入）。 */
export async function buildApp(svc: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

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
  registerBrowseRoutes(app)
  registerConfigRoutes(app, svc)
  registerWs(app, svc)
  return app
}

interface CreateProjectBody {
  name?: string
  description?: string
  workdir?: string
  team?: TeamAddInput[]
}

function registerProjectRoutes(app: FastifyInstance, svc: Services): void {
  const { projectService, teamService } = svc

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

  app.get<{ Params: { pid: string } }>('/api/projects/:pid', async (req) => ({
    project: await projectService.get(req.params.pid),
  }))

  app.patch<{
    Params: { pid: string }
    Body: { name?: string; description?: string }
  }>('/api/projects/:pid', async (req) => ({
    project: await projectService.patch(req.params.pid, req.body ?? {}),
  }))

  app.delete<{ Params: { pid: string }; Querystring: { force?: string } }>(
    '/api/projects/:pid',
    async (req, reply) => {
      void req.query
      await projectService.remove(req.params.pid)
      return reply.code(204).send()
    },
  )
}

function registerTeamRoutes(app: FastifyInstance, svc: Services): void {
  const { teamService } = svc

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
  }>('/api/projects/:pid/team/:iid', async (req) => ({
    member: await teamService.patch(req.params.pid, req.params.iid, req.body ?? {}),
  }))

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

function registerRoleRoutes(app: FastifyInstance, svc: Services): void {
  const rs = svc.roleService

  app.get('/api/roles', async () => ({ roles: await rs.list() }))

  app.post<{ Body: RoleBody }>('/api/roles', async (req, reply) => {
    const created = await rs.create(req.body ?? {})
    return reply.code(201).send({ role: created })
  })

  app.patch<{ Params: { roleId: string }; Body: RoleBody }>('/api/roles/:roleId', async (req) => {
    const b = req.body ?? {}
    const { roleId: _ignored, ...patch } = b
    void _ignored
    return { role: await rs.update(req.params.roleId, patch) }
  })

  app.delete<{ Params: { roleId: string } }>('/api/roles/:roleId', async (req, reply) => {
    await rs.remove(req.params.roleId)
    return reply.code(204).send()
  })
}

function registerSessionRoutes(app: FastifyInstance, svc: Services): void {
  const ss = svc.sessionService

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/sessions', async (req) => ({
    sessions: await ss.listSessions(req.params.pid),
  }))

  app.get<{
    Params: { pid: string; sid: string }
    Querystring: { beforeSeq?: string; limit?: string }
  }>('/api/projects/:pid/sessions/:sid', async (req) => {
    const meta = await ss.getSession(req.params.pid, req.params.sid)
    const messages = await ss.getMessages(req.params.pid, req.params.sid, {
      beforeSeq: req.query.beforeSeq ? Number(req.query.beforeSeq) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
    return { session: meta, messages }
  })

  app.get<{
    Params: { pid: string; sid: string }
    Querystring: { fromSeq?: string; kind?: string }
  }>('/api/projects/:pid/sessions/:sid/log', async (req) => {
    const events = await ss.getRawLog(req.params.pid, req.params.sid, {
      fromSeq: req.query.fromSeq ? Number(req.query.fromSeq) : undefined,
      kind: req.query.kind,
    })
    return { events }
  })

  app.post<{ Params: { pid: string; sid: string }; Body: { text?: string } }>(
    '/api/projects/:pid/sessions/:sid/messages',
    async (req, reply) => {
      const r = await ss.sendUserMessage(req.params.pid, req.params.sid, req.body?.text ?? '')
      return reply.code(202).send(r)
    },
  )
}

function registerBrowseRoutes(app: FastifyInstance): void {
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

function registerConfigRoutes(app: FastifyInstance, svc: Services): void {
  const cfg = svc.config
  app.get('/api/config', async () => ({
    server: cfg.server,
    models: {
      default: cfg.models.default,
      providers: cfg.models.providers.map((p) => ({ ...p, apiKeyEnv: undefined })),
    },
    approval: cfg.approval,
    sandbox: cfg.sandbox,
    task: cfg.task,
    search: cfg.search,
    context: cfg.context,
  }))
}

/** WS /ws?projectId=…：订阅事件总线并下行（JSON 文本帧）。 */
function registerWs(app: FastifyInstance, svc: Services): void {
  app.get<{ Querystring: { projectId?: string } }>('/ws', { websocket: true }, (socket, req) => {
    const projectId = req.query?.projectId
    const unsub = svc.bus.subscribe({
      projectId: projectId || undefined,
      sessionId: undefined,
      onEvent: (evt) => {
        if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(evt))
      },
    })
    socket.on('close', () => unsub())
  })
}
