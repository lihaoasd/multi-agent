import type { FastifyInstance } from 'fastify'
import {
  browseDirectory,
  getHomeAndDrives,
  mkdirUnder,
  type Services,
} from '../../application/composition.js'

export function registerTaskRoutes(app: FastifyInstance, svc: Services): void {
  const { tasks } = svc
  const { fileOwners, projectService } = svc

  // 产出物署名与归属（2026-09-12）：谁写的、什么时候、什么任务
  app.get<{ Params: { pid: string }; Querystring: { owner?: string; mine?: string } }>(
    '/api/projects/:pid/file-owners',
    async (req) => {
      const all = await fileOwners.list(req.params.pid)
      const team = await projectService.listTeam(req.params.pid).catch(() => [])
      const nameOf = (owner: string) =>
        team.find((m) => m.instanceId === owner)?.displayName ?? owner
      const filtered = req.query.owner ? all.filter((r) => r.owner === req.query.owner) : all
      return {
        files: filtered.map((r) => ({ ...r, ownerName: r.ownerName || nameOf(r.owner) })),
      }
    },
  )

  app.get<{
    Params: { pid: string }
    Querystring: { assignee?: string; state?: string }
  }>('/api/projects/:pid/tasks', async (req) => ({
    tasks: await tasks.list(req.params.pid, {
      assignee: req.query.assignee,
      state: req.query.state as never,
    }),
  }))

  app.post<{
    Params: { pid: string }
    Body: {
      title?: string
      desc?: string
      creator?: string
      assignee?: string
      sessionId?: string
      force?: boolean
    }
  }>('/api/projects/:pid/tasks', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.title || !b.assignee) {
      return reply.code(400).send({ code: 'ERR_VALIDATION', message: 'title/assignee 必填' })
    }
    const r = await tasks.create(
      {
        projectId: req.params.pid,
        title: b.title,
        desc: b.desc,
        creator: b.creator ?? 'user',
        assignee: b.assignee,
        sessionId: b.sessionId,
      },
      { force: b.force === true },
    )
    if (r.duplicate) return reply.code(200).send({ task: r.task, duplicate: true })
    return reply.code(201).send({ task: r.task, duplicate: false })
  })

  app.patch<{
    Params: { pid: string; tid: string }
    Body: { state?: string; actor?: string; note?: string }
  }>('/api/projects/:pid/tasks/:tid', async (req) => {
    const b = req.body ?? {}
    if (!b.state) return { code: 'ERR_VALIDATION', message: 'state 必填' }
    const task = await tasks.setState(
      req.params.pid,
      req.params.tid,
      b.state as never,
      b.actor ?? 'user',
      b.note,
    )
    return { task }
  })
}

export function registerAttentionRoute(app: FastifyInstance, svc: Services): void {
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/needs-attention', async (req) => ({
    items: await svc.attention.list(req.params.pid),
  }))
}

export function registerBrowseRoutes(app: FastifyInstance): void {
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

  // 用户主目录与常用盘符（向导快捷入口）
  app.get('/api/fs/home', async () => getHomeAndDrives())

  // 用户级新建目录（向导「新建文件夹」，父目录必须已存在）
  app.post<{ Body: { parent?: string; name?: string } }>('/api/fs/mkdir', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.parent || !b.name) {
      return reply.code(400).send({ code: 'ERR_VALIDATION', message: 'parent/name 必填' })
    }
    const path = await mkdirUnder(b.parent, b.name)
    return reply.code(201).send({ path })
  })
}

export function registerConfigRoutes(app: FastifyInstance, svc: Services): void {
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
export function registerWs(app: FastifyInstance, svc: Services): void {
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

