/**
 * In-process event bus: broadcast session events AFTER they are persisted (persist-then-push).
 * Session log is the source of truth (memory.md sec 2); streaming chunks are transient (not logged).
 */
import type { SessionLogEvent } from '../../shared/types/session.js'

export interface BusSubscriber {
  projectId?: string
  sessionId?: string
  onEvent: (evt: WsEventLike) => void
}

/** Downlink event (UI projection of a log event, or a streaming chunk). */
export interface WsEventLike {
  type: string
  projectId?: string
  sessionId?: string
  payload: Record<string, unknown>
}

export class EventBus {
  private readonly subscribers = new Set<BusSubscriber>()

  subscribe(s: BusSubscriber): () => void {
    this.subscribers.add(s)
    return () => this.subscribers.delete(s)
  }

  /** Broadcast a persisted log event as its UI projection. */
  emitLogEvent(projectId: string, evt: SessionLogEvent): void {
    this.publish({
      type: eventKindToWsType(evt.kind),
      projectId,
      sessionId: evt.sessionId,
      payload: {
        seq: evt.seq,
        ts: evt.ts,
        turn: evt.turn,
        kind: evt.kind,
        role: evt.role,
        sender: evt.sender,
        content: evt.content,
        ...(evt.payload ?? {}),
      },
    })
  }

  /** Streaming text chunk (message.chunk; NOT persisted). */
  emitChunk(
    projectId: string,
    sessionId: string,
    payload: { turnId?: string; delta: string },
  ): void {
    this.publish({
      type: 'message.chunk',
      projectId,
      sessionId,
      payload: { sessionId, ...payload },
    })
  }

  /** Full message persisted (message.commit). */
  emitCommit(
    projectId: string,
    sessionId: string,
    payload: { seq: number; turnId?: string },
  ): void {
    this.publish({
      type: 'message.commit',
      projectId,
      sessionId,
      payload: { sessionId, ...payload },
    })
  }

  /** Session meta / state change. */
  emitSessionUpdated(projectId: string, sessionId: string, meta: Record<string, unknown>): void {
    this.publish({ type: 'session.updated', projectId, sessionId, payload: { sessionId, ...meta } })
  }

  /** Generic broadcast (agent.state / team.updated / artifact.updated ...). */
  emit(
    type: string,
    projectId: string | undefined,
    sessionId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    this.publish({ type, projectId, sessionId, payload })
  }

  private publish(evt: WsEventLike): void {
    for (const s of this.subscribers) {
      if (s.projectId !== undefined && evt.projectId !== undefined && s.projectId !== evt.projectId)
        continue
      if (s.sessionId !== undefined && evt.sessionId !== undefined && s.sessionId !== evt.sessionId)
        continue
      try {
        s.onEvent(evt)
      } catch {
        // subscriber error must not break the bus
      }
    }
  }
}

function eventKindToWsType(kind: string): string {
  switch (kind) {
    case 'message':
      return 'event.appended'
    case 'turn_start':
    case 'turn_end':
      return 'event.appended'
    case 'state':
      return 'agent.state'
    case 'artifact':
      return 'artifact.updated'
    case 'approval_request':
      return 'approval.requested'
    case 'approval_result':
      return 'approval_result'
    default:
      return 'event.appended'
  }
}
