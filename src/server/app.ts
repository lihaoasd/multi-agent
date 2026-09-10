/**
 * HTTP 服务组装（Fastify）：REST + WS + 统一错误映射。
 * 错误响应体统一 { code, message }（api/contract.md §1）。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { join } from 'node:path'

import { ErrorCodes, isAppError } from '../shared/errors.js'
import {
  browseDirectory,
  getHomeAndDrives,
  mkdirUnder,
} from '../application/fs-browse/fs-browse-service.js'
import { collectProjectFiles } from '../application/export/export-service.js'
import AdmZip from 'adm-zip'
import type { RoleTemplate } from '../shared/types/role.js'
import type { Services } from '../application/composition.js'
import { composeToolEnv } from '../application/composition.js'
import { QuestionService } from '../application/question/question-service.js'
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

  // 已读回执（未读计算）：body {seq} = 用户已读到的最大 seq
  app.post<{ Params: { pid: string; sid: string }; Body: { seq?: number } }>(
    '/api/projects/:pid/sessions/:sid/read',
    async (req) => {
      const session = await ss.markRead(req.params.pid, req.params.sid, req.body?.seq ?? 0)
      return { session }
    },
  )
}

function registerApprovalRoutes(app: FastifyInstance, svc: Services): void {
  const { approvals, tools } = svc

  app.get<{ Params: { pid: string }; Querystring: { status?: string } }>(
    '/api/projects/:pid/approvals',
    async (req) => ({ approvals: await approvals.list(req.params.pid, req.query.status) }),
  )

  app.post<{
    Params: { pid: string; apid: string }
    Body: { decision?: string; reason?: string }
  }>('/api/projects/:pid/approvals/:apid/decide', async (req) => {
    const decision = req.body?.decision
    if (decision !== 'approved' && decision !== 'rejected') {
      return { code: 'ERR_VALIDATION', message: 'decision 必须为 approved|rejected' }
    }
    const rec = await approvals.decide(req.params.pid, req.params.apid, decision, req.body?.reason)
    let resumed: unknown = null
    if (rec.status === 'approved' && rec.kind === 'command') {
      const env = await composeToolEnv(svc, req.params.pid, rec.actor).catch(() => null)
      if (env) resumed = await tools.resumeCommand(req.params.pid, rec.id, env)
    }
    return { approval: rec, resumed }
  })
}

function registerArtifactRoutes(app: FastifyInstance, svc: Services): void {
  const { artifacts } = svc

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/artifacts', async (req) => ({
    artifacts: await artifacts.list(req.params.pid),
  }))

  app.get<{ Params: { pid: string; aid: string } }>(
    '/api/projects/:pid/artifacts/:aid',
    async (req) => {
      const rec = await artifacts.get(req.params.pid, req.params.aid)
      return {
        artifact: rec,
        versions: await artifacts.listVersions(req.params.pid, req.params.aid),
      }
    },
  )

  app.post<{ Params: { pid: string; aid: string }; Body: { toVersion?: number } }>(
    '/api/projects/:pid/artifacts/:aid/rollback',
    async (req) => {
      const rec = await artifacts.rollback(req.params.pid, req.params.aid, req.body?.toVersion)
      return { artifact: rec }
    },
  )
}

function registerMemorySearchRoutes(app: FastifyInstance, svc: Services): void {
  const { memory, search } = svc

  app.get<{
    Params: { pid: string }
    Querystring: { q?: string; scope?: string; instanceId?: string; type?: string; limit?: string }
  }>('/api/projects/:pid/search', async (req) => {
    const q = req.query.q ?? ''
    if (!q.trim()) return { q: '', sessions: [], memories: [] }
    return search.search(req.params.pid, q)
  })

  // 记忆列表（只读浏览 MVP；M1 版本见 contract）
  app.get<{
    Params: { pid: string }
    Querystring: { scope?: string; instanceId?: string; type?: string; limit?: string }
  }>('/api/projects/:pid/memories', async (req) => {
    const scope = req.query.scope === 'role' ? 'role' : 'global'
    const entries = await memory.listActive(req.params.pid, {
      scope,
      instanceId: req.query.instanceId,
      type: req.query.type as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
    return { entries }
  })
}

function registerMeetingRoutes(app: FastifyInstance, svc: Services): void {
  const { meetings } = svc

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/meetings', async (req) => ({
    meetings: await meetings.list(req.params.pid),
  }))

  app.post<{
    Params: { pid: string }
    Body: { host?: string; topic?: string; desc?: string; agenda?: string[]; members?: string[] }
  }>('/api/projects/:pid/meetings', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.host || !b.topic || !Array.isArray(b.members)) {
      return reply.code(400).send({ code: 'ERR_VALIDATION', message: 'host/topic/members 必填' })
    }
    const meeting = await meetings.create({
      projectId: req.params.pid,
      host: b.host,
      topic: b.topic,
      desc: b.desc,
      agenda: b.agenda ?? [],
      members: b.members,
    })
    return reply.code(201).send({ meeting })
  })

  app.post<{
    Params: { pid: string; mid: string }
    Body: { member?: string; decision?: string }
  }>('/api/projects/:pid/meetings/:mid/respond', async (req) => {
    const b = req.body ?? {}
    if (!b.member || !['accept', 'later', 'decline'].includes(b.decision ?? '')) {
      return { code: 'ERR_VALIDATION', message: 'member + decision(accept|later|decline) 必填' }
    }
    const meeting = await meetings.respond(
      req.params.pid,
      req.params.mid,
      b.member,
      b.decision as never,
    )
    return { meeting }
  })

  app.post<{
    Params: { pid: string; mid: string }
    Body: { asker?: string; question?: string; options?: string[] }
  }>('/api/projects/:pid/meetings/:mid/ask', async (req) => {
    const b = req.body ?? {}
    if (!b.asker || !b.question) {
      return { code: 'ERR_VALIDATION', message: 'asker/question 必填' }
    }
    const dp = await meetings.askUser(
      req.params.pid,
      req.params.mid,
      b.asker,
      b.question,
      b.options ?? [],
    )
    return { decisionPoint: dp }
  })

  app.post<{
    Params: { pid: string; mid: string }
    Body: { questionId?: string; choice?: string; text?: string }
  }>('/api/projects/:pid/meetings/:mid/decision', async (req) => {
    const b = req.body ?? {}
    if (!b.questionId) return { code: 'ERR_VALIDATION', message: 'questionId 必填' }
    const meeting = await meetings.answerDecision(req.params.pid, req.params.mid, b.questionId, {
      choice: b.choice,
      text: b.text,
    })
    return { meeting }
  })

  app.post<{
    Params: { pid: string; mid: string }
    Body: { host?: string; member?: string; question?: string }
  }>('/api/projects/:pid/meetings/:mid/talk', async (req) => {
    const b = req.body ?? {}
    if (!b.host || !b.member) {
      return { code: 'ERR_VALIDATION', message: 'host/member 必填（主持人点名成员发言）' }
    }
    await meetings.speakTurn(req.params.pid, req.params.mid, b.host, b.member, b.question)
    return { ok: true }
  })

  app.post<{ Params: { pid: string; mid: string }; Body: { text?: string } }>(
    '/api/projects/:pid/meetings/:mid/messages',
    async (req) => {
      await meetings.userInterject(req.params.pid, req.params.mid, req.body?.text ?? '')
      return { ok: true }
    },
  )

  app.post<{ Params: { pid: string; mid: string } }>(
    '/api/projects/:pid/meetings/:mid/regenerate-minutes',
    async (req) => ({ minutes: await meetings.regenerateMinutes(req.params.pid, req.params.mid) }),
  )

  app.post<{ Params: { pid: string; mid: string }; Body: { actor?: string } }>(
    '/api/projects/:pid/meetings/:mid/close',
    async (req) => {
      const meeting = await meetings.close(
        req.params.pid,
        req.params.mid,
        req.body?.actor ?? 'user',
      )
      return { meeting }
    },
  )

  app.post<{ Params: { pid: string; mid: string }; Body: { actor?: string } }>(
    '/api/projects/:pid/meetings/:mid/cancel',
    async (req) => {
      await meetings.cancel(req.params.pid, req.params.mid, req.body?.actor ?? 'user')
      return { ok: true }
    },
  )

  app.get<{ Params: { pid: string; mid: string } }>(
    '/api/projects/:pid/meetings/:mid/minutes',
    async (req) => ({
      minutes: await meetings.getMinutes(req.params.pid, req.params.mid),
    }),
  )

  // D17-⑦ 纪要待办转出任务（一步化：勾选即建）
  app.post<{
    Params: { pid: string; mid: string }
    Body: { title?: string; assignee?: string }
  }>('/api/projects/:pid/meetings/:mid/minutes/tasks', async (req) => {
    const b = req.body ?? {}
    if (!b.assignee) return { code: 'ERR_VALIDATION', message: 'assignee 必填' }
    const task = await meetings.createTaskFromMinutes(req.params.pid, req.params.mid, {
      title: b.title,
      assignee: b.assignee,
    })
    return { task }
  })
}

function registerQuestionRoutes(app: FastifyInstance, svc: Services): void {
  const { questions, sessionService, sessionStore } = svc

  app.get<{
    Params: { pid: string }
    Querystring: { status?: string; sessionId?: string }
  }>('/api/projects/:pid/questions', async (req) => ({
    questions: await questions.list(req.params.pid, {
      status: req.query.status,
      sessionId: req.query.sessionId,
    }),
  }))

  /**
   * 回答提问：落 answered → 把答复作为一条用户消息写回会话 → 触发 Agent 回合继续。
   * （会话不存在/非 user 会话/角色停用时只落记录，返回 wakeError 说明。）
   */
  app.post<{
    Params: { pid: string; qid: string }
    Body: { choice?: string; choices?: string[]; text?: string }
  }>('/api/projects/:pid/questions/:qid/answer', async (req) => {
    const pid = req.params.pid
    const rec = await questions.answer(pid, req.params.qid, {
      choice: req.body?.choice,
      choices: req.body?.choices,
      text: req.body?.text,
    })
    let wakeError: string | null = null
    const meta = await sessionStore.tryReadMeta(pid, rec.sessionId)
    if (!meta) wakeError = `会话不存在: ${rec.sessionId}`
    else if (meta.type !== 'user') wakeError = '非 user 会话，答复未回注 Agent'
    else {
      try {
        await sessionService.sendUserMessage(pid, rec.sessionId, QuestionService.answerText(rec))
      } catch (e) {
        wakeError = `答复未触发 Agent 回合：${e instanceof Error ? e.message : String(e)}`
      }
    }
    return { question: rec, wakeError }
  })
}

function registerExportRoutes(app: FastifyInstance, svc: Services): void {
  const projectsRoot = join(svc.config.dataDir, 'projects')
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/export', async (req, reply) => {
    const files = await collectProjectFiles(projectsRoot, req.params.pid)
    const zip = new AdmZip()
    for (const f of files) zip.addLocalFile(f.path, '', f.rel)
    const buf = zip.toBuffer()
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${req.params.pid}.zip"`)
      .send(buf)
  })
}

function registerTaskRoutes(app: FastifyInstance, svc: Services): void {
  const { tasks } = svc

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
    Body: { title?: string; desc?: string; creator?: string; assignee?: string; sessionId?: string }
  }>('/api/projects/:pid/tasks', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.title || !b.assignee) {
      return reply.code(400).send({ code: 'ERR_VALIDATION', message: 'title/assignee 必填' })
    }
    const task = await tasks.create({
      projectId: req.params.pid,
      title: b.title,
      desc: b.desc,
      creator: b.creator ?? 'user',
      assignee: b.assignee,
      sessionId: b.sessionId,
    })
    return reply.code(201).send({ task })
  })

  app.patch<{
    Params: { pid: string; tid: string }
    Body: { state?: string; actor?: string }
  }>('/api/projects/:pid/tasks/:tid', async (req) => {
    const b = req.body ?? {}
    if (!b.state) return { code: 'ERR_VALIDATION', message: 'state 必填' }
    const task = await tasks.setState(
      req.params.pid,
      req.params.tid,
      b.state as never,
      b.actor ?? 'user',
    )
    return { task }
  })
}

function registerAttentionRoute(app: FastifyInstance, svc: Services): void {
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/needs-attention', async (req) => ({
    items: await svc.attention.list(req.params.pid),
  }))
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
