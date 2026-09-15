import type { FastifyInstance } from 'fastify'
import type { Dispatcher } from '../../ports/dispatcher'
import type { EventKind } from '../../ports/session'
import type { SessionService } from '../../application/session/session-service'
import { replyFromResult } from '../errors'
import { asRecord, requireString } from './parse'

export interface SessionRouteContext {
  readonly sessions: SessionService
  readonly dispatcher: Dispatcher
}

const KINDS: readonly EventKind[] = [
  'turn_start',
  'turn_end',
  'plan',
  'message',
  'thought',
  'tool_call',
  'tool_result',
  'approval_request',
  'approval_result',
  'artifact',
  'state',
  'summary',
  'error',
]

function parseKinds(raw: string | undefined): readonly EventKind[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const wanted = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is EventKind => (KINDS as readonly string[]).includes(item))
  return wanted.length === 0 ? undefined : wanted
}

/** 查询参数里的可选数字（非法/缺省 → undefined） */
function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 会话与消息路由（contract.md §2「会话 / 消息」+「Agent 运行控制」的暂停/恢复） */
export function registerSessionRoutes(app: FastifyInstance, context: SessionRouteContext): void {
  const { sessions, dispatcher } = context

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/sessions', async (request, reply) =>
    replyFromResult(reply, await sessions.list(request.params.pid)),
  )

  app.get<{ Params: { pid: string; sid: string }; Querystring: { limit?: string } }>(
    '/api/projects/:pid/sessions/:sid',
    async (request, reply) => {
      const meta = await sessions.get(request.params.pid, request.params.sid)
      if (!meta.ok) return replyFromResult(reply, meta)
      const limit = optionalNumber(request.query.limit)
      const window = await sessions.window(request.params.pid, request.params.sid, {
        limit: limit === undefined ? 200 : limit,
      })
      if (!window.ok) return replyFromResult(reply, window)
      return replyFromResult(reply, { ok: true as const, value: { meta: meta.value, events: window.value } })
    },
  )

  app.get<{ Params: { pid: string; sid: string }; Querystring: { fromSeq?: string; kind?: string; limit?: string } }>(
    '/api/projects/:pid/sessions/:sid/log',
    async (request, reply) => {
      const fromSeq = optionalNumber(request.query.fromSeq)
      const limit = optionalNumber(request.query.limit)
      const events = await sessions.history(request.params.pid, request.params.sid, parseKinds(request.query.kind), {
        ...(fromSeq === undefined ? {} : { fromSeq }),
        ...(limit === undefined ? {} : { limit }),
      })
      return replyFromResult(reply, events)
    },
  )

  app.post<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/sessions/:sid/messages',
    async (request, reply) => {
      const body = asRecord(request.body)
      const text = requireString(body, 'text')
      if (!text.ok) return replyFromResult(reply, text)
      const result = await dispatcher.submitUserMessage({
        projectId: request.params.pid,
        sessionId: request.params.sid,
        text: text.value,
      })
      return replyFromResult(reply, result, 202)
    },
  )

  app.post<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/agents/:iid/pause', async (request, reply) =>
    replyFromResult(reply, await dispatcher.setPaused(request.params.pid, request.params.iid, true)),
  )

  app.post<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/agents/:iid/resume', async (request, reply) => {
    const resumed = await dispatcher.setPaused(request.params.pid, request.params.iid, false)
    if (!resumed.ok) return replyFromResult(reply, resumed)
    // 恢复后立刻补处理排队消息（D18-③：不要求用户再发消息唤醒）
    const drained = await dispatcher.drain(request.params.pid, request.params.iid)
    if (!drained.ok) return replyFromResult(reply, drained)
    return replyFromResult(reply, { ok: true as const, value: { ...resumed.value, handled: drained.value.handled } })
  })

  app.post<{ Params: { pid: string } }>('/api/projects/:pid/dispatcher/resume-queued', async (request, reply) =>
    replyFromResult(reply, await dispatcher.resumeQueued(request.params.pid)),
  )

}
