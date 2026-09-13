import type { FastifyInstance } from 'fastify'
import type { RoleTemplate } from '../../shared/types/role.js'
import {
  composeToolEnv,
  type Services,
} from '../../application/composition.js'

/** 角色模板创建/更新入参（P4 随路由一起从 app.ts 搬来）。 */
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

export function registerRoleRoutes(app: FastifyInstance, svc: Services): void {
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

export function registerSessionRoutes(app: FastifyInstance, svc: Services): void {
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

export function registerApprovalRoutes(app: FastifyInstance, svc: Services): void {
  const { approvals, tools, sessionService, sessionStore } = svc

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
    // 产出物提交门：批准后把私有区稿件实际落盘到项目工作目录（此前漏了这一步）
    if (rec.status === 'approved' && rec.kind === 'submit') {
      resumed = await svc.artifacts.finalizeApproved(req.params.pid, rec.id).catch(() => null)
    }
    // 审批是**阻塞式**的：角色提交审批后就停在「等待你处理」；这里把结果回注会话并唤醒它继续，
    // 否则角色会一直等（或误以为要自己想办法绕过）。
    let wakeError: string | null = null
    if (rec.sessionId) {
      const meta = await sessionStore.tryReadMeta(req.params.pid, rec.sessionId).catch(() => null)
      if (!meta) wakeError = `会话不存在: ${rec.sessionId}`
      else if (meta.type !== 'user') wakeError = '非 user 会话，审批结果未回注角色'
      else {
        const r = resumed as { ok?: boolean; summary?: string; code?: string; reason?: string } | null
        const outcome = r
          ? r.ok
            ? `执行成功：${String(r.summary ?? '').slice(0, 600)}`
            : `执行失败（${r.code ?? 'ERR'}）：${String(r.reason ?? '').slice(0, 300)}`
          : '（无可执行动作）'
        const text =
          rec.status === 'approved'
            ? `【系统】你申请的审批 ${rec.id} 已获批准，平台已执行：${rec.summary}\n${outcome}\n请继续你的任务。`
            : `【系统】你申请的审批 ${rec.id} 已被用户拒绝：${rec.summary}` +
              `（原因：${req.body?.reason ?? '未说明'}）。不要重复申请该动作；请改用其他方式或向用户说明。`
        try {
          await sessionService.sendUserMessage(req.params.pid, rec.sessionId, text, { system: true })
        } catch (e) {
          wakeError = `审批结果未唤醒角色：${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
    return { approval: rec, resumed, wakeError }
  })
}

