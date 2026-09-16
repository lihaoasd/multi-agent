import type { FastifyInstance } from 'fastify'
import type { ModelConfigService, ProviderUpdateInput, ModelUpdateInput } from '../../application/model-config/service'
import type { ModelInput, ProviderInput } from '../../application/model-config/validate'
import type { AgentReference } from '../../application/team/template-references'
import type { ProviderKind } from '../../ports/model'
import type { EventBroadcaster } from '../../ports/events'
import { err, ok } from '../../shared/result'
import { replyFromResult } from '../errors'
import {
  asRecord,
  readBoolean,
  readCredential,
  readNumber,
  readString,
  readStringArray,
  requireString,
} from './parse'

export interface ModelConfigRouteContext {
  readonly service: ModelConfigService
  readonly broadcaster: EventBroadcaster
  /** 未配置模型的 Agent（S11/D22-④）：随 overview 返回，供"一键设为全局默认"提示 */
  readonly unconfiguredAgents?: () => Promise<readonly AgentReference[]>
}

function providerInputOf(record: Record<string, unknown>, id: string): ProviderInput {
  const credential = readCredential(record)
  const headers = record['headers']
  return {
    id,
    name: readString(record, 'name') ?? id,
    kind: (readString(record, 'kind') ?? 'openai-compatible') as ProviderKind,
    baseUrl: readString(record, 'baseUrl') ?? '',
    ...(credential === undefined ? {} : { credential }),
    ...(typeof headers === 'object' && headers !== null
      ? { headers: headers as Record<string, string> }
      : {}),
    ...(readBoolean(record, 'enabled') === undefined ? {} : { enabled: readBoolean(record, 'enabled') }),
    ...(readNumber(record, 'timeoutMs') === undefined ? {} : { timeoutMs: readNumber(record, 'timeoutMs') }),
    ...(readString(record, 'presetId') === undefined ? {} : { presetId: readString(record, 'presetId') }),
  }
}

function modelInputOf(record: Record<string, unknown>, id: string): ModelInput {
  const capabilities = readStringArray(record, 'capabilities')
  const defaultParamsRaw = record['defaultParams']
  const temperature =
    typeof defaultParamsRaw === 'object' && defaultParamsRaw !== null
      ? readNumber(defaultParamsRaw as Record<string, unknown>, 'temperature')
      : undefined
  return {
    id,
    providerId: readString(record, 'providerId') ?? '',
    model: readString(record, 'model') ?? '',
    ...(readString(record, 'displayName') === undefined ? {} : { displayName: readString(record, 'displayName') }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(readNumber(record, 'contextWindow') === undefined ? {} : { contextWindow: readNumber(record, 'contextWindow') }),
    ...(readNumber(record, 'maxOutputTokens') === undefined
      ? {}
      : { maxOutputTokens: readNumber(record, 'maxOutputTokens') }),
    ...(temperature === undefined ? {} : { defaultParams: { temperature } }),
  }
}

/** 模型配置路由（contract.md §2「模型配置」） */
export function registerModelConfigRoutes(app: FastifyInstance, context: ModelConfigRouteContext): void {
  const { service, broadcaster } = context
  const notify = (kind: 'provider' | 'model' | 'routing', id: string): void => {
    broadcaster.broadcast({ type: 'model-config.updated', payload: { kind, id } })
  }

  app.get('/api/model-presets', () => service.listPresets())

  app.get('/api/model-providers', async (_request, reply) => {
    const overview = await service.overview()
    return replyFromResult(
      reply,
      overview.ok ? { ok: true as const, value: overview.value.providers } : overview,
    )
  })

  app.post('/api/model-providers', async (request, reply) => {
    const body = asRecord(request.body)
    const presetId = readString(body, 'presetId')
    const preset = presetId === undefined ? undefined : service.listPresets().find((item) => item.presetId === presetId)
    const id = readString(body, 'id') ?? preset?.presetId ?? ''
    if (id.length === 0) {
      return replyFromResult(reply, err('ERR_VALIDATION', '缺少必填字段：id'))
    }
    const input = providerInputOf(body, id)
    const merged: ProviderInput = {
      ...input,
      ...(readString(body, 'kind') === undefined && preset !== undefined ? { kind: preset.kind } : {}),
      ...(readString(body, 'baseUrl') === undefined && preset !== undefined ? { baseUrl: preset.baseUrl } : {}),
      ...(readString(body, 'name') === undefined && preset !== undefined ? { name: preset.name } : {}),
      presetId: preset?.presetId ?? null,
    }
    const created = await service.createProvider(merged)
    if (created.ok) notify('provider', created.value.id)
    return replyFromResult(reply, created, 201)
  })

  app.patch<{ Params: { pid: string } }>('/api/model-providers/:pid', async (request, reply) => {
    const body = asRecord(request.body)
    const patch: ProviderUpdateInput = {
      ...(readString(body, 'name') === undefined ? {} : { name: readString(body, 'name') }),
      ...(readString(body, 'kind') === undefined ? {} : { kind: readString(body, 'kind') as ProviderKind }),
      ...(readString(body, 'baseUrl') === undefined ? {} : { baseUrl: readString(body, 'baseUrl') }),
      ...(readBoolean(body, 'enabled') === undefined ? {} : { enabled: readBoolean(body, 'enabled') }),
      ...(readNumber(body, 'timeoutMs') === undefined ? {} : { timeoutMs: readNumber(body, 'timeoutMs') }),
      ...(readCredential(body) === undefined ? {} : { credential: readCredential(body) }),
    }
    const updated = await service.updateProvider(request.params.pid, patch)
    if (updated.ok) notify('provider', updated.value.id)
    return replyFromResult(reply, updated)
  })

  app.delete<{ Params: { pid: string } }>('/api/model-providers/:pid', async (request, reply) => {
    const deleted = await service.deleteProvider(request.params.pid)
    if (deleted.ok) notify('provider', request.params.pid)
    return replyFromResult(reply, deleted)
  })

  app.post<{ Params: { pid: string }; Body: unknown }>('/api/model-providers/:pid/test', async (request, reply) => {
    const body = asRecord(request.body)
    const mode = readString(body, 'mode') === 'chat' ? 'chat' : 'models'
    const modelId = readString(body, 'modelId')
    const result = await service.testProvider(request.params.pid, {
      mode,
      ...(modelId === undefined ? {} : { modelId }),
    })
    return replyFromResult(reply, result)
  })

  app.get<{ Params: { pid: string } }>('/api/model-providers/:pid/discover', async (request, reply) => {
    const result = await service.discoverModels(request.params.pid)
    return replyFromResult(reply, result.ok ? { ok: true as const, value: { models: result.value } } : result)
  })

  app.get('/api/models', async (_request, reply) => {
    const overview = await service.overview()
    return replyFromResult(reply, overview.ok ? { ok: true as const, value: overview.value.models } : overview)
  })

  app.post('/api/models', async (request, reply) => {
    const body = asRecord(request.body)
    const id = requireString(body, 'id')
    if (!id.ok) return replyFromResult(reply, id)
    const created = await service.createModel(modelInputOf(body, id.value))
    if (created.ok) notify('model', created.value.id)
    return replyFromResult(reply, created, 201)
  })

  app.post('/api/models/bulk', async (request, reply) => {
    const body = asRecord(request.body)
    const providerId = requireString(body, 'providerId')
    if (!providerId.ok) return replyFromResult(reply, providerId)
    const rawModels = Array.isArray(body['models']) ? body['models'] : []
    const inputs = rawModels.map((item, index) => {
      const record = asRecord(item)
      return modelInputOf(record, readString(record, 'id') ?? `bulk-${index}`)
    })
    const created = await service.bulkCreateModels(providerId.value, inputs)
    if (created.ok) notify('model', providerId.value)
    return replyFromResult(reply, created, 201)
  })

  app.patch<{ Params: { mid: string } }>('/api/models/:mid', async (request, reply) => {
    const body = asRecord(request.body)
    const patch: ModelUpdateInput = {
      ...(readString(body, 'displayName') === undefined ? {} : { displayName: readString(body, 'displayName') }),
      ...(readString(body, 'model') === undefined ? {} : { model: readString(body, 'model') }),
      ...(readString(body, 'providerId') === undefined ? {} : { providerId: readString(body, 'providerId') }),
      ...(readStringArray(body, 'capabilities') === undefined ? {} : { capabilities: readStringArray(body, 'capabilities') }),
      ...(readBoolean(body, 'enabled') === undefined ? {} : { enabled: readBoolean(body, 'enabled') }),
      ...(readBoolean(body, 'confirm') === undefined ? {} : { confirm: readBoolean(body, 'confirm') }),
      ...(readNumber(body, 'contextWindow') === undefined ? {} : { contextWindow: readNumber(body, 'contextWindow') }),
      ...(readNumber(body, 'maxOutputTokens') === undefined
        ? {}
        : { maxOutputTokens: readNumber(body, 'maxOutputTokens') }),
    }
    const updated = await service.updateModel(request.params.mid, patch)
    if (updated.ok) notify('model', updated.value.id)
    return replyFromResult(reply, updated)
  })

  app.delete<{ Params: { mid: string }; Querystring: { confirm?: string } }>(
    '/api/models/:mid',
    async (request, reply) => {
      const confirm = request.query.confirm === 'true'
      const deleted = await service.deleteModel(request.params.mid, confirm)
      if (deleted.ok) notify('model', request.params.mid)
      return replyFromResult(reply, deleted)
    },
  )

  app.get('/api/model-routing', async (_request, reply) => {
    const overview = await service.overview()
    return replyFromResult(reply, overview.ok ? { ok: true as const, value: overview.value.routing } : overview)
  })

  app.put('/api/model-routing', async (request, reply) => {
    const body = asRecord(request.body)
    const overridesRaw = body['stepOverrides']
    const stepOverrides =
      typeof overridesRaw === 'object' && overridesRaw !== null
        ? Object.fromEntries(
            Object.entries(overridesRaw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {}
    const updated = await service.updateRouting({
      defaultModelId: readString(body, 'defaultModelId') ?? null,
      stepOverrides,
    })
    if (updated.ok) notify('routing', 'routing')
    return replyFromResult(reply, updated)
  })

  app.get('/api/model-config/overview', async (_request, reply) => {
    const overview = await service.overview()
    if (!overview.ok) return replyFromResult(reply, overview)
    const items = context.unconfiguredAgents === undefined ? [] : await context.unconfiguredAgents()
    return replyFromResult(reply, ok({ ...overview.value, unconfiguredAgents: { total: items.length, items } }))
  })

  app.post<{ Querystring: { source?: string } }>('/api/model-config/import', async (request, reply) => {
    const source = request.query.source === 'v0' ? 'v0' : 'env'
    const imported = await service.importLegacy(source)
    if (imported.ok) notify('provider', source)
    return replyFromResult(reply, imported)
  })
}
