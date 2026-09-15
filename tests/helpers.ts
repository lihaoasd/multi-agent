import type { EventBroadcaster, ServerEvent } from '../src/ports/events'
import type { LogFields, Logger } from '../src/ports/logger'

/** 静默 Logger（单测用）：不产生输出，保留 child 语义 */
export function createTestLogger(): Logger {
  const build = (): Logger => ({
    level: 'error',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => build(),
  })
  return build()
}

/** 记录型 Logger（断言日志内容时用） */
export function createRecordingLogger(): Logger & { records(): readonly LogFields[] } {
  const records: LogFields[] = []
  const build = (base: LogFields): Logger => ({
    level: 'debug',
    debug: (message, fields) => records.push({ level: 'debug', message, ...base, ...fields }),
    info: (message, fields) => records.push({ level: 'info', message, ...base, ...fields }),
    warn: (message, fields) => records.push({ level: 'warn', message, ...base, ...fields }),
    error: (message, fields) => records.push({ level: 'error', message, ...base, ...fields }),
    child: (fields) => build({ ...base, ...fields }),
  })
  return { ...build({}), records: () => records }
}

/**
 * 记录型广播器 + 转发：既保留事件供断言，又透传给真实实时通道（WS Hub）。
 * 测试里若只注入纯录制广播器，服务的事件就不会到达 WS 连接（S3 的 WS 用例正是靠这一点被发现的）。
 */
export function createRecordingForwardingBroadcaster(
  forward: EventBroadcaster,
): EventBroadcaster & { events(): readonly ServerEvent[] } {
  const events: ServerEvent[] = []
  return {
    broadcast: (event: ServerEvent) => {
      events.push(event)
      forward.broadcast(event)
    },
    events: () => events,
  }
}
