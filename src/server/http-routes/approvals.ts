import type { FastifyInstance } from 'fastify'
import type { ApprovalService } from '../../application/approval/approval-service'
import type { ApprovalStatus } from '../../ports/approval'
import { replyFromResult } from '../errors'
import { asRecord, readString } from './parse'

export interface ApprovalRouteContext {
  readonly approvals: ApprovalService
}

/** 审批路由（contract.md §2「产出物 / 任务 / 审批 / 搜索」中的审批部分） */
export function registerApprovalRoutes(app: FastifyInstance, context: ApprovalRouteContext): void {
  const { approvals } = context

  app.get<{ Params: { pid: string }; Querystring: { status?: string; actor?: string } }>(
    '/api/projects/:pid/approvals',
    async (request, reply) => {
      const status = request.query.status
      const filter: { status?: ApprovalStatus; actor?: string } = {}
      if (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'expired') {
        filter.status = status
      }
      if (request.query.actor !== undefined && request.query.actor.length > 0) filter.actor = request.query.actor
      return replyFromResult(reply, await approvals.list(request.params.pid, filter))
    },
  )

  app.post<{ Params: { pid: string; apid: string } }>(
    '/api/projects/:pid/approvals/:apid/decide',
    async (request, reply) => {
      const body = asRecord(request.body)
      const decision = readString(body, 'decision')
      if (decision !== 'approved' && decision !== 'rejected') {
        return replyFromResult(reply, {
          ok: false,
          error: { code: 'ERR_VALIDATION', message: 'decision 必须是 approved 或 rejected' },
        })
      }
      const result = await approvals.decide(
        request.params.pid,
        request.params.apid,
        decision,
        readString(body, 'reason'),
      )
      return replyFromResult(reply, result)
    },
  )
}
