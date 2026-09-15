import type { EventBroadcaster, ServerEvent } from '../../ports/events'

/**
 * 空广播器：S1/S2 阶段尚无 WS 网关（S3 接入真实实现）。
 * 保留端口使路由层的广播调用位置在后期**无需改动**。
 */
export function createNoopEventBroadcaster(): EventBroadcaster {
  return {
    // 无订阅者：事件到此丢弃（S3 换成 WS 广播实现）
    broadcast: (): void => undefined,
  }
}

/** 记录型广播器（测试断言广播内容用） */
export function createRecordingEventBroadcaster(): EventBroadcaster & { events(): readonly ServerEvent[] } {
  const events: ServerEvent[] = []
  return {
    broadcast: (event: ServerEvent) => {
      events.push(event)
    },
    events: () => events,
  }
}
