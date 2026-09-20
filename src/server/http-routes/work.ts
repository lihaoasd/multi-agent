import type { FastifyInstance } from 'fastify'
import type { ArtifactService } from '../../ports/artifact'
import type { TaskService } from '../../ports/task'
import type { QuestionService } from '../../ports/question'
import { ARTIFACT_TYPES, TASK_STATES, type ArtifactState, type ArtifactType, type TaskState } from '../../shared/artifacts'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'
import { asRecord, readString, requireString } from './parse'

/**
 * 产出物 / 任务 / 询问路由（contract.md §2「产出物 / 任务 / 审批 / 搜索」）：
 * - `GET /api/projects/:pid/artifacts`、`GET .../artifacts/:aid`、`GET .../artifacts/:aid/versions`、`POST .../artifacts/:aid/rollback`
 * - `GET /api/projects/:pid/file-owners?owner=`
 * - `GET/POST /api/projects/:pid/tasks`、`PATCH .../tasks/:tid`
 * - `GET /api/projects/:pid/questions?status=&sessionId=`、`POST .../questions/:qid/answer`
 *
 * 用户（老板）视角：可以回退任何产出物（不受"只能回退自己"的 Agent 限制）。
 */

export interface WorkRouteContext {
  readonly artifacts: ArtifactService
  readonly tasks: TaskService
  readonly questions: QuestionService
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function registerArtifactRoutes(app: FastifyInstance, context: WorkRouteContext): void {
  const { artifacts, tasks, questions } = context

  app.get<{ Params: { pid: string }; Querystring: { type?: string; submitter?: string; state?: string; taskId?: string; limit?: string } }>(
    '/api/projects/:pid/artifacts',
    async (request, reply) => {
      const { type, submitter, state, taskId } = request.query
      if (type !== undefined && !(ARTIFACT_TYPES as readonly string[]).includes(type)) {
        return replyFromResult(reply, err('ERR_VALIDATION', `未知产出物类型：${type}`, { allowed: ARTIFACT_TYPES }))
      }
      const limit = optionalNumber(request.query.limit)
      return replyFromResult(
        reply,
        await artifacts.list(request.params.pid, {
          ...(type === undefined ? {} : { type: type as ArtifactType }),
          ...(submitter === undefined ? {} : { submitter }),
          ...(state === undefined ? {} : { state: state as ArtifactState }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
    },
  )

  app.get<{ Params: { pid: string; aid: string } }>('/api/projects/:pid/artifacts/:aid', async (request, reply) =>
    replyFromResult(reply, await artifacts.get(request.params.pid, request.params.aid)),
  )

  app.get<{ Params: { pid: string; aid: string } }>('/api/projects/:pid/artifacts/:aid/versions', async (request, reply) =>
    replyFromResult(reply, await artifacts.versions(request.params.pid, request.params.aid)),
  )

  app.post<{ Params: { pid: string; aid: string } }>('/api/projects/:pid/artifacts/:aid/rollback', async (request, reply) => {
    const body = asRecord(request.body)
    const version = body['version']
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      return replyFromResult(reply, err('ERR_VALIDATION', '缺少 version', { field: 'version' }))
    }
    // S54/D58：mode 缺省 undo（撤销这一版）；restore＝退回到该版本的内容（用户界面用）
    const mode = body['mode']
    if (mode !== undefined && mode !== 'undo' && mode !== 'restore') {
      return replyFromResult(reply, err('ERR_VALIDATION', `未知回退方式：${String(mode)}`, { allowed: ['undo', 'restore'] }))
    }
    const artifact = await artifacts.get(request.params.pid, request.params.aid)
    if (!artifact.ok) return replyFromResult(reply, artifact)
    // 用户侧回退：以提交者身份代行（用户不受"只能回退自己"的 Agent 限制）
    return replyFromResult(
      reply,
      await artifacts.rollback({
        projectId: request.params.pid,
        instanceId: artifact.value.submitter,
        artifactId: request.params.aid,
        version: Math.floor(version),
        ...(mode === undefined ? {} : { mode }),
        ...(body['force'] === true ? { force: true } : {}),
        sessionId: artifact.value.sessionId,
        turn: artifact.value.turn,
      }),
    )
  })

  app.get<{ Params: { pid: string }; Querystring: { owner?: string } }>(
    '/api/projects/:pid/file-owners',
    async (request, reply) =>
      replyFromResult(
        reply,
        await artifacts.listOwners(request.params.pid, {
          ...(request.query.owner === undefined ? {} : { owner: request.query.owner }),
        }),
      ),
  )

  app.get<{ Params: { pid: string }; Querystring: { state?: string; assignee?: string; creator?: string; limit?: string } }>(
    '/api/projects/:pid/tasks',
    async (request, reply) => {
      const { state, assignee, creator } = request.query
      if (state !== undefined && !(TASK_STATES as readonly string[]).includes(state)) {
        return replyFromResult(reply, err('ERR_VALIDATION', `未知任务状态：${state}`, { allowed: TASK_STATES }))
      }
      const limit = optionalNumber(request.query.limit)
      return replyFromResult(
        reply,
        await tasks.list(request.params.pid, {
          ...(state === undefined ? {} : { state: state as TaskState }),
          ...(assignee === undefined ? {} : { assignee }),
          ...(creator === undefined ? {} : { creator }),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
    },
  )

  app.post<{ Params: { pid: string } }>('/api/projects/:pid/tasks', async (request, reply) => {
    const body = asRecord(request.body)
    const title = requireString(body, 'title')
    if (!title.ok) return replyFromResult(reply, title)
    const assignee = requireString(body, 'assignee')
    if (!assignee.ok) return replyFromResult(reply, assignee)
    const created = await tasks.create({
      projectId: request.params.pid,
      title: title.value,
      desc: readString(body, 'desc') ?? '',
      creator: readString(body, 'creator') ?? 'user',
      assignee: assignee.value,
      sessionId: readString(body, 'sessionId') ?? `u_${assignee.value}`,
      ...(body['force'] === true ? { force: true } : {}),
    })
    if (!created.ok) return replyFromResult(reply, created)
    // 撞车去重：命中重复返回 200 + duplicate=true；新建返回 201
    return replyFromResult(
      reply,
      { ok: true as const, value: { task: created.value.task, duplicate: created.value.duplicate } },
      created.value.duplicate ? 200 : 201,
    )
  })

  app.patch<{ Params: { pid: string; tid: string } }>('/api/projects/:pid/tasks/:tid', async (request, reply) => {
    const body = asRecord(request.body)
    const state = readString(body, 'state')
    if (state === undefined || !(TASK_STATES as readonly string[]).includes(state)) {
      return replyFromResult(reply, err('ERR_VALIDATION', `state 必须是 ${TASK_STATES.join('/')}`, { field: 'state' }))
    }
    return replyFromResult(
      reply,
      await tasks.setState(request.params.pid, request.params.tid, state as TaskState, {
        actor: readString(body, 'actor') ?? 'user',
        ...(readString(body, 'note') === undefined ? {} : { note: readString(body, 'note') as string }),
      }),
    )
  })

  app.get<{ Params: { pid: string }; Querystring: { status?: string; sessionId?: string; limit?: string } }>(
    '/api/projects/:pid/questions',
    async (request, reply) => {
      const { status, sessionId } = request.query
      if (status !== undefined && status !== 'pending' && status !== 'answered') {
        return replyFromResult(reply, err('ERR_VALIDATION', `未知询问状态：${status}`, { allowed: ['pending', 'answered'] }))
      }
      const limit = optionalNumber(request.query.limit)
      return replyFromResult(
        reply,
        await questions.list(request.params.pid, {
          ...(status === undefined ? {} : { status }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
    },
  )

  app.post<{ Params: { pid: string; qid: string } }>(
    '/api/projects/:pid/questions/:qid/answer',
    async (request, reply) => {
      const body = asRecord(request.body)
      const raw = body['answers']
      if (!Array.isArray(raw) || raw.length === 0) {
        return replyFromResult(reply, err('ERR_VALIDATION', 'answers 不能为空', { field: 'answers' }))
      }
      const answers: { itemId: string; choice: string | null; text: string | null }[] = []
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        const itemId = typeof record['itemId'] === 'string' ? record['itemId'] : ''
        if (itemId.length === 0) continue
        const choice = typeof record['choice'] === 'string' ? record['choice'] : null
        const text = typeof record['text'] === 'string' ? record['text'] : null
        answers.push({ itemId, choice, text })
      }
      if (answers.length === 0) {
        return replyFromResult(reply, err('ERR_VALIDATION', 'answers 需要形如 [{itemId, choice?/text?}]'))
      }
      return replyFromResult(reply, await questions.answer(request.params.pid, request.params.qid, answers))
    },
  )

  app.post<{ Params: { pid: string } }>('/api/projects/:pid/tasks/:tid/settle-preview', async (request, reply) => {
    const body = asRecord(request.body)
    const key = readString(body, 'key')
    if (key === undefined) return replyFromResult(reply, err('ERR_VALIDATION', '缺少 key'))
    return replyFromResult(reply, await artifacts.pendingSummary(request.params.pid, key))
  })

  // 供前端右栏展示"未结算改动"（任务级聚合的实时视图，D14-⑧）
  app.get<{ Params: { pid: string }; Querystring: { key?: string } }>(
    '/api/projects/:pid/pending-edits',
    async (request, reply) => {
      const key = request.query.key
      if (key === undefined) return replyFromResult(reply, err('ERR_VALIDATION', '缺少 key'))
      const pending = await artifacts.pending(request.params.pid, key)
      if (!pending.ok) return replyFromResult(reply, pending)
      const summary = await artifacts.pendingSummary(request.params.pid, key)
      if (!summary.ok) return replyFromResult(reply, summary)
      return replyFromResult(reply, { ok: true as const, value: { edits: pending.value, ...summary.value } })
    },
  )
}
