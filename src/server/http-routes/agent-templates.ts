import type { FastifyInstance } from 'fastify'
import type { AgentConfigService } from '../../application/team/agent-config-service'
import type { EventBroadcaster } from '../../ports/events'
import type { LoopConfig, RoleTemplateCreateInput, RoleTemplatePatch } from '../../ports/role-templates'
import { replyFromResult } from '../errors'
import { err } from '../../shared/result'
import { asRecord, readLoopConfig, readString, requireString } from './parse'

export interface AgentTemplateRouteContext {
  readonly service: AgentConfigService
  readonly broadcaster: EventBroadcaster
}

function loopPatchOf(record: Record<string, unknown>): LoopConfig | undefined {
  const loop = readLoopConfig(record)
  return loop === undefined ? undefined : { strategy: loop.strategy, params: loop.params }
}

/** Agent 模板路由（contract.md §2「首页库」；FR-35 开放 提示词/loop/模型 三项） */
export function registerAgentTemplateRoutes(app: FastifyInstance, context: AgentTemplateRouteContext): void {
  const { service, broadcaster } = context
  const notify = (roleId: string): void => {
    broadcaster.broadcast({ type: 'agent-config.updated', payload: { scope: 'template', roleId } })
  }

  app.get<{ Querystring: { scenario?: string } }>('/api/agent-templates', async (request, reply) => {
    const listed = await service.list(request.query.scenario)
    return replyFromResult(reply, listed)
  })

  app.get<{ Params: { roleId: string } }>('/api/agent-templates/:roleId', async (request, reply) => {
    const template = await service.get(request.params.roleId)
    return replyFromResult(reply, template)
  })

  app.get<{ Params: { roleId: string } }>('/api/agent-templates/:roleId/history', async (request, reply) => {
    const history = await service.listHistory(request.params.roleId)
    return replyFromResult(reply, history)
  })

  app.post('/api/agent-templates', async (request, reply) => {
    const body = asRecord(request.body)
    const roleId = requireString(body, 'roleId')
    if (!roleId.ok) return replyFromResult(reply, roleId)
    const copyFrom = readString(body, 'copyFrom') ?? roleId.value
    const defaultModel = body['defaultModel']
    const input: RoleTemplateCreateInput = {
      roleId: roleId.value,
      copyFrom,
      ...(readString(body, 'name') === undefined ? {} : { name: readString(body, 'name') }),
      ...(readString(body, 'scenario') === undefined ? {} : { scenario: readString(body, 'scenario') }),
      ...(readString(body, 'systemPrompt') === undefined ? {} : { systemPrompt: readString(body, 'systemPrompt') }),
      ...(loopPatchOf(body) === undefined ? {} : { defaultLoop: loopPatchOf(body) }),
      ...(defaultModel === undefined ? {} : { defaultModel: typeof defaultModel === 'string' ? defaultModel : null }),
    }
    const created = await service.create(input)
    if (created.ok) notify(created.value.roleId)
    return replyFromResult(reply, created, 201)
  })

  app.patch<{ Params: { roleId: string } }>('/api/agent-templates/:roleId', async (request, reply) => {
    const body = asRecord(request.body)
    const defaultModel = body['defaultModel']
    const patch: RoleTemplatePatch = {
      ...(readString(body, 'systemPrompt') === undefined ? {} : { systemPrompt: readString(body, 'systemPrompt') }),
      ...(loopPatchOf(body) === undefined ? {} : { defaultLoop: loopPatchOf(body) }),
      ...(defaultModel === undefined
        ? {}
        : { defaultModel: typeof defaultModel === 'string' ? defaultModel : null }),
    }
    const updated = await service.update(request.params.roleId, patch)
    if (updated.ok) notify(updated.value.roleId)
    return replyFromResult(reply, updated)
  })

  for (const [suffix, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    app.post<{ Params: { roleId: string } }>(`/api/agent-templates/:roleId/${suffix}`, async (request, reply) => {
      const updated = await service.setEnabled(request.params.roleId, enabled)
      if (updated.ok) notify(updated.value.roleId)
      return replyFromResult(reply, updated)
    })
  }

  /** 删除用户模板（内置模板只能停用）；`confirm=true` 二次确认，被项目引用 → `ERR_CONFLICT` + referrers */
  app.delete<{ Params: { roleId: string }; Querystring: { confirm?: string } }>(
    '/api/agent-templates/:roleId',
    async (request, reply) => {
      const removed = await service.remove(request.params.roleId, request.query.confirm === 'true')
      if (removed.ok) notify(removed.value.deleted)
      return replyFromResult(reply, removed)
    },
  )

  /** 批量设置默认模型（内置与用户模板均可，S11/D22-③）：`{ roleIds: string[], defaultModel: string | null }` */
  app.post('/api/agent-templates/bulk-model', async (request, reply) => {
    const body = asRecord(request.body)
    const roleIds = body['roleIds']
    if (!Array.isArray(roleIds) || roleIds.some((item) => typeof item !== 'string')) {
      return replyFromResult(reply, err('ERR_VALIDATION', 'roleIds 必须是字符串数组'))
    }
    const rawModel = body['defaultModel']
    if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') {
      return replyFromResult(reply, err('ERR_VALIDATION', 'defaultModel 必须是模型条目 id 或 null'))
    }
    const result = await service.bulkSetDefaultModel(roleIds as string[], rawModel ?? null)
    if (result.ok) for (const roleId of result.value.updated) notify(roleId)
    return replyFromResult(reply, result)
  })
}
