import type { ServerEvent, WsClientHandle, WsRealtime } from '../../ports/events'

/**
 * WS 客户端注册表 + 事件广播（S3 实现，替换 S1/S2 的 noop 广播器）。
 * 路由规则：事件 payload 里带 `projectId` → 只发给订阅了该项目的连接；不带 → 视为全局事件发给所有连接。
 */
export type WsEventHub = WsRealtime

export function createWsEventHub(): WsEventHub {
  const clients = new Map<string, { readonly handle: WsClientHandle; readonly projects: Set<string> }>()

  return {
    addClient(handle: WsClientHandle, projectId: string | null): void {
      const projects = new Set<string>()
      if (projectId !== null && projectId.length > 0) projects.add(projectId)
      clients.set(handle.id, { handle, projects })
    },

    removeClient(clientId: string): void {
      clients.delete(clientId)
    },

    subscribe(clientId: string, projectId: string): void {
      clients.get(clientId)?.projects.add(projectId)
    },

    unsubscribe(clientId: string, projectId: string): void {
      clients.get(clientId)?.projects.delete(projectId)
    },

    clientCount(): number {
      return clients.size
    },

    subscriberCount(projectId: string): number {
      let count = 0
      for (const client of clients.values()) if (client.projects.has(projectId)) count += 1
      return count
    },

    broadcast(event: ServerEvent): void {
      const projectId = typeof event.payload['projectId'] === 'string' ? event.payload['projectId'] : null
      const frame = JSON.stringify(event)
      for (const client of clients.values()) {
        if (projectId !== null && !client.projects.has(projectId)) continue
        try {
          client.handle.send(frame)
        } catch {
          // 单个连接发送失败不影响其它连接（连接清理由 socket close 负责）
        }
      }
    },
  }
}
