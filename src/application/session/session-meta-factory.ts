import type { InstanceId, ProjectId } from '../../ports/project'
import type { SessionId, SessionMeta, SessionState } from '../../ports/session'

/** 会话 meta 工厂（纯函数；application 层用，避免依赖 infra 的文件存储实现） */
export function createSessionMeta(input: {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly instanceId: InstanceId
  readonly nowIso: string
  readonly state?: SessionState
}): SessionMeta {
  return {
    schemaVersion: 1,
    id: input.sessionId,
    type: 'user',
    projectId: input.projectId,
    participants: { user: true, agents: [input.instanceId] },
    state: input.state ?? 'active',
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    closedAt: null,
    lastSeq: 0,
    segments: [],
    summaryRefs: [],
  }
}
