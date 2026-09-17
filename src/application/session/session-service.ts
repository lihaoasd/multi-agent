import type { Clock } from '../../ports/clock'
import type { ProjectStore } from '../../ports/project'
import type {
  EventKind,
  NewEvent,
  ReadWindowOptions,
  SessionId,
  SessionLogStore,
  SessionMeta,
  SessionMetaStore,
  SessionState,
  SessionSummary,
  StoredEvent,
} from '../../ports/session'
import { createSessionMeta } from './session-meta-factory'
import { err, ok, type Result } from '../../shared/result'
import type { EventPipeline } from './event-pipeline'

export interface SessionServiceOptions {
  readonly metaStore: SessionMetaStore
  readonly logStore: SessionLogStore
  readonly pipeline: EventPipeline
  readonly projectStore: ProjectStore
  readonly clock: Clock
}

export interface SessionService {
  /** 会话 id 约定：用户 ↔ 角色 1:1 会话 = `u_<instanceId>`（项目内唯一、长期） */
  sessionIdFor(instanceId: string): SessionId
  /** 项目创建后补齐每个实例的会话（幂等；已存在则跳过） */
  ensureProjectSessions(projectId: string): Promise<Result<readonly SessionId[]>>
  list(projectId: string): Promise<Result<readonly SessionSummary[]>>
  get(projectId: string, sessionId: SessionId): Promise<Result<SessionMeta>>
  window(projectId: string, sessionId: SessionId, opts?: ReadWindowOptions): Promise<Result<readonly StoredEvent[]>>
  history(
    projectId: string,
    sessionId: SessionId,
    kinds?: readonly EventKind[],
    opts?: ReadWindowOptions,
  ): Promise<Result<readonly StoredEvent[]>>
  append(projectId: string, sessionId: SessionId, events: readonly NewEvent[]): Promise<Result<readonly StoredEvent[]>>
  /** 新对话：清空该会话全部历史事件 */
  reset(projectId: string, sessionId: SessionId): Promise<Result<SessionMeta>>
  /** 实例停用/启用时同步会话状态（停用 → archived 只读；启用 → active），D14-9 */
  syncInstanceState(projectId: string, instanceId: string, enabled: boolean): Promise<Result<SessionMeta>>
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { metaStore, logStore, pipeline, projectStore, clock } = options

  const sessionIdFor = (instanceId: string): SessionId => `u_${instanceId}`

  const previewOf = (events: readonly StoredEvent[]): string | null => {
    const lastMessage = [...events].reverse().find((event) => event.kind === 'message')
    if (lastMessage === undefined) return null
    const content = lastMessage.payload['content']
    if (typeof content === 'object' && content !== null) {
      const text = (content as Record<string, unknown>)['text']
      if (typeof text === 'string') return text.slice(0, 80)
    }
    if (typeof lastMessage.payload['text'] === 'string') return (lastMessage.payload['text'] as string).slice(0, 80)
    return null
  }

  const service: SessionService = {
    sessionIdFor,

    async ensureProjectSessions(projectId: string): Promise<Result<readonly SessionId[]>> {
      const project = await projectStore.get(projectId)
      if (!project.ok) return project
      const existing = await metaStore.list(projectId)
      if (!existing.ok) return existing
      const known = new Set(existing.value.map((meta) => meta.id))
      const created: SessionId[] = []
      const nowIso = clock.now().toISOString()

      for (const instance of project.value.team) {
        const sessionId = sessionIdFor(instance.instanceId)
        if (known.has(sessionId)) continue
        const meta = createSessionMeta({
          sessionId,
          projectId,
          instanceId: instance.instanceId,
          nowIso,
          // 停用实例的会话归档只读（D14-9）；重新启用时改回 active
          state: instance.enabled ? 'active' : 'archived',
        })
        const result = await metaStore.create(meta)
        if (!result.ok && result.error.code !== 'ERR_CONFLICT') return result
        created.push(sessionId)
      }
      return ok(created)
    },

    async list(projectId: string): Promise<Result<readonly SessionSummary[]>> {
      const project = await projectStore.get(projectId)
      if (!project.ok) return project
      const metas = await metaStore.list(projectId)
      if (!metas.ok) return metas

      const summaries: SessionSummary[] = []
      for (const meta of metas.value) {
        const instanceId = meta.participants.agents[0] ?? meta.id.replace(/^u_/, '')
        const instance = project.value.team.find((item) => item.instanceId === instanceId)
        const window = await logStore.readWindow(projectId, meta.id, { limit: 20 })
        summaries.push({
          sessionId: meta.id,
          projectId,
          instanceId,
          displayName: instance?.displayName ?? instanceId,
          state: meta.state,
          lastSeq: meta.lastSeq,
          updatedAt: meta.updatedAt,
          lastMessagePreview: window.ok ? previewOf(window.value) : null,
        })
      }
      summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return ok(summaries)
    },

    async get(projectId: string, sessionId: SessionId): Promise<Result<SessionMeta>> {
      return metaStore.get(projectId, sessionId)
    },

    async window(
      projectId: string,
      sessionId: SessionId,
      opts?: ReadWindowOptions,
    ): Promise<Result<readonly StoredEvent[]>> {
      return logStore.readWindow(projectId, sessionId, opts)
    },

    async history(
      projectId: string,
      sessionId: SessionId,
      kinds?: readonly EventKind[],
      opts?: ReadWindowOptions,
    ): Promise<Result<readonly StoredEvent[]>> {
      return kinds === undefined || kinds.length === 0
        ? logStore.readWindow(projectId, sessionId, opts)
        : logStore.readKinds(projectId, sessionId, kinds, opts)
    },

    async append(
      projectId: string,
      sessionId: SessionId,
      events: readonly NewEvent[],
    ): Promise<Result<readonly StoredEvent[]>> {
      const meta = await metaStore.get(projectId, sessionId)
      if (!meta.ok) return meta
      if (meta.value.state === 'archived') {
        return err('ERR_CONFLICT', '该会话已归档（实例已停用），不能写入', { sessionId })
      }
      return pipeline.append(projectId, sessionId, events)
    },

    async reset(projectId: string, sessionId: SessionId): Promise<Result<SessionMeta>> {
      return logStore.reset(projectId, sessionId)
    },

    async syncInstanceState(
      projectId: string,
      instanceId: string,
      enabled: boolean,
    ): Promise<Result<SessionMeta>> {
      const sessionId = sessionIdFor(instanceId)
      const meta = await metaStore.get(projectId, sessionId)
      if (!meta.ok) return meta
      const target: SessionState = enabled ? 'active' : 'archived'
      if (meta.value.state === target) return meta
      return metaStore.update(projectId, sessionId, (value) => ({ ok: true, value: { ...value, state: target } }))
    },
  }

  return service
}
