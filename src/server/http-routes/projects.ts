import type { FastifyInstance } from 'fastify'
import type { ProjectService } from '../../application/project/service'
import type { InstancePatch, TeamService } from '../../application/team/team-service'
import type { EventBroadcaster } from '../../ports/events'
import type { LoopConfig } from '../../ports/role-templates'
import { replyFromResult } from '../errors'
import { asRecord, readBoolean, readLoopConfig, readString, requireString } from './parse'

export interface ProjectRouteContext {
  readonly project: ProjectService
  readonly team: TeamService
  readonly broadcaster: EventBroadcaster
}

function readMembers(record: Record<string, unknown>): readonly { roleTemplateId: string; displayName?: string }[] | undefined {
  const raw = record['members']
  if (!Array.isArray(raw)) return undefined
  const members: { roleTemplateId: string; displayName?: string }[] = []
  for (const item of raw) {
    const entry = asRecord(item)
    const roleTemplateId = readString(entry, 'roleTemplateId')
    if (roleTemplateId === undefined) continue
    const displayName = readString(entry, 'displayName')
    members.push(displayName === undefined ? { roleTemplateId } : { roleTemplateId, displayName })
  }
  return members
}

function readInstancePatch(record: Record<string, unknown>): InstancePatch {
  const prompt = record['prompt']
  const model = record['model']
  const loopRaw = record['loop']
  const displayName = readString(record, 'displayName')
  const enabled = readBoolean(record, 'enabled')

  // `null` 表示"清除覆盖、回到模板快照"；对象才解析为 loop 配置
  let loop: LoopConfig | null | undefined
  if (loopRaw === null) {
    loop = null
  } else {
    const parsed = readLoopConfig(record, 'loop')
    if (parsed !== undefined) loop = { strategy: parsed.strategy, params: parsed.params }
  }

  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(prompt === undefined ? {} : { prompt: typeof prompt === 'string' ? prompt : null }),
    ...(model === undefined ? {} : { model: typeof model === 'string' ? model : null }),
    ...(loop === undefined ? {} : { loop }),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

/** 项目与团队路由（contract.md §2「项目」「角色库 / 团队」「目录浏览器」） */
export function registerProjectRoutes(app: FastifyInstance, context: ProjectRouteContext): void {
  const { project, team, broadcaster } = context
  const notifyTeam = (projectId: string, instanceId: string, action: string): void => {
    broadcaster.broadcast({ type: 'team.updated', payload: { projectId, instanceId, action } })
  }

  app.get('/api/projects', async (_request, reply) => replyFromResult(reply, await project.list()))

  app.post('/api/projects', async (request, reply) => {
    const body = asRecord(request.body)
    const name = requireString(body, 'name')
    if (!name.ok) return replyFromResult(reply, name)
    const workdir = requireString(body, 'workdir')
    if (!workdir.ok) return replyFromResult(reply, workdir)
    const members = readMembers(body)
    const created = await project.create({
      name: name.value,
      ...(readString(body, 'description') === undefined ? {} : { description: readString(body, 'description') }),
      workdir: workdir.value,
      ...(members === undefined ? {} : { members }),
    })
    return replyFromResult(reply, created, 201)
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid', async (request, reply) =>
    replyFromResult(reply, await project.get(request.params.pid)),
  )

  app.patch<{ Params: { pid: string } }>('/api/projects/:pid', async (request, reply) => {
    const body = asRecord(request.body)
    const updated = await project.updateMeta(request.params.pid, {
      ...(readString(body, 'name') === undefined ? {} : { name: readString(body, 'name') }),
      ...(readString(body, 'description') === undefined ? {} : { description: readString(body, 'description') }),
    })
    return replyFromResult(reply, updated)
  })

  app.delete<{ Params: { pid: string } }>('/api/projects/:pid', async (request, reply) =>
    replyFromResult(reply, await project.remove(request.params.pid)),
  )

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/team', async (request, reply) =>
    replyFromResult(reply, await team.listInstances(request.params.pid)),
  )

  app.post<{ Params: { pid: string } }>('/api/projects/:pid/team', async (request, reply) => {
    const body = asRecord(request.body)
    const roleTemplateId = requireString(body, 'roleTemplateId')
    if (!roleTemplateId.ok) return replyFromResult(reply, roleTemplateId)
    const created = await team.addInstance(request.params.pid, {
      roleTemplateId: roleTemplateId.value,
      ...(readString(body, 'displayName') === undefined ? {} : { displayName: readString(body, 'displayName') }),
    })
    if (created.ok) notifyTeam(request.params.pid, created.value.instanceId, 'added')
    return replyFromResult(reply, created, 201)
  })

  app.get<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/team/:iid', async (request, reply) =>
    replyFromResult(reply, await team.getInstance(request.params.pid, request.params.iid)),
  )

  app.patch<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/team/:iid', async (request, reply) => {
    const updated = await team.patchInstance(
      request.params.pid,
      request.params.iid,
      readInstancePatch(asRecord(request.body)),
    )
    if (updated.ok) notifyTeam(request.params.pid, request.params.iid, 'configured')
    return replyFromResult(reply, updated)
  })

  app.delete<{ Params: { pid: string; iid: string } }>('/api/projects/:pid/team/:iid', async (request, reply) => {
    // 删除 = 停用（保留会话/记忆，可重新启用，D14-9）
    const updated = await team.setEnabled(request.params.pid, request.params.iid, false)
    if (updated.ok) notifyTeam(request.params.pid, request.params.iid, 'disabled')
    return replyFromResult(reply, updated)
  })

  app.post<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/team/:iid/enable',
    async (request, reply) => {
      const updated = await team.setEnabled(request.params.pid, request.params.iid, true)
      if (updated.ok) notifyTeam(request.params.pid, request.params.iid, 'enabled')
      return replyFromResult(reply, updated)
    },
  )

  app.get<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/team/:iid/effective-config',
    async (request, reply) =>
      replyFromResult(reply, await team.effectiveConfig(request.params.pid, request.params.iid)),
  )

  // 团队实时状态投影（左栏/画布用）；dispatcher 接通后由它提供 state（S3）
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/agents', async (request, reply) => {
    const instances = await team.listInstances(request.params.pid)
    if (!instances.ok) return replyFromResult(reply, instances)
    return replyFromResult(
      reply,
      {
        ok: true as const,
        value: instances.value.map((instance) => ({
          instanceId: instance.instanceId,
          displayName: instance.displayName,
          enabled: instance.enabled,
          state: 'idle' as const,
          sessionId: null,
          currentTask: null,
        })),
      },
    )
  })

  app.get<{ Querystring: { path?: string; includeHidden?: string } }>('/api/fs/browse', async (request, reply) => {
    const path = request.query.path
    const result = await project.browse(path === undefined || path.length === 0 ? null : path, {
      includeHidden: request.query.includeHidden === 'true',
    })
    return replyFromResult(reply, result)
  })

  app.post('/api/fs/inspect', async (request, reply) => {
    const body = asRecord(request.body)
    const path = requireString(body, 'path')
    if (!path.ok) return replyFromResult(reply, path)
    return replyFromResult(reply, await project.inspectWorkdir(path.value))
  })
}
