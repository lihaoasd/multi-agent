/**
 * 服务端下行事件（WS 投影的真源见 docs/api/contract.md §3）。
 * S1 只需要"配置类"事件；完整 WS 网关（订阅/上行/seq 投影）在 S3 接入。
 */
export interface ServerEvent {
  readonly type: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface EventBroadcaster {
  broadcast(event: ServerEvent): void
}

/** WS 连接句柄（server 层只认这个接口，具体连接实现由 infra 持有） */
export interface WsClientHandle {
  readonly id: string
  send(frame: string): void
}

/**
 * 实时通道（S3 接入）：连接注册 + 订阅 + 广播。
 * 路由规则：事件 payload 带 `projectId` → 只发给订阅该项目的连接；不带 → 全局事件发给所有连接。
 */
export interface WsRealtime extends EventBroadcaster {
  addClient(handle: WsClientHandle, projectId: string | null): void
  removeClient(clientId: string): void
  subscribe(clientId: string, projectId: string): void
  unsubscribe(clientId: string, projectId: string): void
  clientCount(): number
  subscriberCount(projectId: string): number
}
