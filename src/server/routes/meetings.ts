import type { FastifyInstance } from 'fastify'
import AdmZip from 'adm-zip'
import { join } from 'node:path'
import {
  collectProjectFiles,
  questionAnswerText,
  withDisplay,
  type Services,
} from '../../application/composition.js'

export function registerMeetingRoutes(app: FastifyInstance, svc: Services): void {
  const { meetings } = svc

  // 会议功能总开关关闭时：会议 REST 一律拒绝（GET 返回空列表，让前端自然地清空会议区），
  // 已落盘的会议数据保留、重新打开即可继续看到。
  if (svc.config.meeting.enabled === false) {
    app.get<{ Params: { pid: string } }>('/api/projects/:pid/meetings', async () => ({
      meetings: [],
      disabled: true,
    }))
    app.post('/api/projects/:pid/meetings', async (_req, reply) =>
      reply.code(409).send({ code: 'ERR_MEETING_DISABLED', message: '会议功能已关闭' }),
    )
    app.all('/api/projects/:pid/meetings/*', async (_req, reply) =>
      reply.code(409).send({ code: 'ERR_MEETING_DISABLED', message: '会议功能已关闭' }),
    )
    return
  }

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/meetings', async (req) => ({
    // displayState（进行中/已结束）+ waiting（排队等槽位）由服务端统一给出，
    // 保证"会议只有进行中和结束两态"的口径在记录页、左栏、右栏一致。
    meetings: await meetings.listForUi(req.params.pid),
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
    // 同一时刻只允许一个会议进行；已有占槽会议时本条落 queued（displayState 仍是"进行中"，waiting=true）
    return reply.code(201).send({ meeting: withDisplay(meeting) })
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
    return { meeting: withDisplay(meeting) }
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

  /**
   * 项目全局记录（项目记录页）：任务完成 + 会议完成的卡片流（时间倒序）。
   * 只读投影，事实源仍是 tasks.jsonl 与会议 meta；不新增状态。
   */
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/records', async (req) => ({
    records: await svc.records.list(req.params.pid),
  }))
}

export function registerQuestionRoutes(app: FastifyInstance, svc: Services): void {
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
    Body: {
      choice?: string
      choices?: string[]
      text?: string
      /** 问题列表逐题作答（推荐）：itemId 缺省按顺序对齐 */
      answers?: Array<{ itemId?: string; choice?: string; choices?: string[]; text?: string }>
    }
  }>('/api/projects/:pid/questions/:qid/answer', async (req) => {
    const pid = req.params.pid
    const { question: rec, next } = await questions.answer(pid, req.params.qid, {
      choice: req.body?.choice,
      choices: req.body?.choices,
      text: req.body?.text,
      answers: req.body?.answers,
    })
    let wakeError: string | null = null
    const meta = await sessionStore.tryReadMeta(pid, rec.sessionId)
    if (!meta) wakeError = `会话不存在: ${rec.sessionId}`
    else if (meta.type !== 'user') wakeError = '非 user 会话，答复未回注 Agent'
    else {
      try {
        // 答复始终写回会话；**但还有排队问题时先不唤醒角色**（下一张卡片立即弹出，
        // 等全部问完再让角色继续，避免它在问题没答完时又跑起来）
        await sessionService.sendUserMessage(pid, rec.sessionId, await questionAnswerText(rec), {
          wake: next === null,
        })
      } catch (e) {
        wakeError = `答复未触发 Agent 回合：${e instanceof Error ? e.message : String(e)}`
      }
    }
    return { question: rec, nextQuestion: next, wakeError }
  })
}

export function registerExportRoutes(app: FastifyInstance, svc: Services): void {
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

