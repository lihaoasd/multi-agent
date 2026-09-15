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
