import type { Clock } from '../../ports/clock'
import type { EventBroadcaster } from '../../ports/events'
import type { ProjectId } from '../../ports/project'
import type { NewEvent, SessionId, SessionLogStore, StoredEvent } from '../../ports/session'
import { ok, type Result } from '../../shared/result'

export interface EventPipelineOptions {
  readonly logStore: SessionLogStore
  readonly broadcaster: EventBroadcaster
  readonly clock: Clock
}

/**
 * 事件管道：**先盘后推**的唯一咽喉（memory.md §2 / D18-⑤a）。
 * 落盘成功（拿到 seq）之后才广播 `event.appended`；`message` 事件额外广播 `message.commit`。
 * 任何写事件的地方都必须经过这里，禁止旁路推送。
 */
export interface EventPipeline {
  append(projectId: ProjectId, sessionId: SessionId, events: readonly NewEvent[]): Promise<Result<readonly StoredEvent[]>>
}

export function createEventPipeline(options: EventPipelineOptions): EventPipeline {
  return {
    async append(
      projectId: ProjectId,
      sessionId: SessionId,
      events: readonly NewEvent[],
    ): Promise<Result<readonly StoredEvent[]>> {
      if (events.length === 0) return ok([])
      const stored = await options.logStore.append(projectId, sessionId, events)
      if (!stored.ok) return stored

      // 到这里事件已在磁盘上（seq 已分配）；开始推送
      for (const event of stored.value) {
        options.broadcaster.broadcast({
          type: 'event.appended',
          payload: { projectId, sessionId, seq: event.seq, kind: event.kind, ts: event.ts },
        })
        if (event.kind === 'message') {
          options.broadcaster.broadcast({ type: 'message.commit', payload: { projectId, sessionId, seq: event.seq } })
        }
      }
      return stored
    },
  }
}
