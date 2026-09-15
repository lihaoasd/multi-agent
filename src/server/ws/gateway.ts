import websocket from '@fastify/websocket'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Dispatcher } from '../../ports/dispatcher'
import type { WsRealtime } from '../../ports/events'
import type { IdGenerator } from '../../ports/id'
import type { Logger } from '../../ports/logger'

export interface WsGatewayContext {
  readonly realtime: WsRealtime
  readonly dispatcher: Dispatcher
  readonly ids: IdGenerator
  readonly logger: Logger
}

/** 上行帧（contract.md §3）：容错解析，坏帧只记日志不中断连接 */
interface UplinkFrame {
  readonly type?: unknown
  readonly payload?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * WS 网关（S3）：`GET /ws?projectId=…`
 * - 上行：`ping` / `subscribe` / `send`（发送用户消息，交 dispatcher 按单工规则派发）；
 * - 下行：`ws.ready`、`pong`，以及由 `WsRealtime` 广播的领域事件（`event.appended`/`message.commit`/
 *   `agent.state`/`team.updated`/`model-config.updated` …）。
 * 顺序保证：领域事件一律"先落盘、后广播"（EventPipeline），本层只负责转发。
 */
export async function registerWsGateway(app: FastifyInstance, context: WsGatewayContext): Promise<void> {
  await app.register(websocket)

  app.get('/ws', { websocket: true }, (socket, request: FastifyRequest) => {
    const query = asRecord(request.query)
    const projectId = typeof query['projectId'] === 'string' && query['projectId'].length > 0 ? query['projectId'] : null
    const clientId = context.ids.next('ws')

    context.realtime.addClient({ id: clientId, send: (frame) => socket.send(frame) }, projectId)
    context.logger.info('WS 已连接', { clientId, projectId, clients: context.realtime.clientCount() })

    const send = (type: string, payload: Record<string, unknown>): void => {
      socket.send(JSON.stringify({ type, payload }))
    }
    send('ws.ready', { clientId, projectId })

    const handleUplink = async (raw: string): Promise<void> => {
      let frame: UplinkFrame
      try {
        frame = JSON.parse(raw) as UplinkFrame
      } catch {
        context.logger.warn('WS 上行帧不是合法 JSON', { clientId })
        return
      }
      const payload = asRecord(frame.payload)

      switch (frame.type) {
        case 'ping':
          send('pong', { ts: new Date().toISOString() })
          return
        case 'subscribe': {
          const target = typeof payload['projectId'] === 'string' ? payload['projectId'] : null
          if (target === null) {
            send('error', { code: 'ERR_VALIDATION', message: 'subscribe 需要 projectId' })
            return
          }
          context.realtime.subscribe(clientId, target)
          send('subscribed', { projectId: target })
          return
        }
        case 'send': {
          const target = typeof payload['projectId'] === 'string' ? payload['projectId'] : null
          const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : null
          const text = typeof payload['text'] === 'string' ? payload['text'] : ''
          if (target === null || sessionId === null) {
            send('error', { code: 'ERR_VALIDATION', message: 'send 需要 projectId 与 sessionId' })
            return
          }
          const result = await context.dispatcher.submitUserMessage({ projectId: target, sessionId, text })
          if (!result.ok) {
            send('error', { code: result.error.code, message: result.error.message })
            return
          }
          send('message.accepted', { sessionId, seq: result.value.seq, queued: result.value.queued })
          return
        }
        default:
          context.logger.warn('未知 WS 上行帧', { clientId, type: String(frame.type) })
          send('error', { code: 'ERR_VALIDATION', message: `未知上行帧类型：${String(frame.type)}` })
      }
    }

    socket.on('message', (raw: unknown) => {
      void handleUplink(typeof raw === 'string' ? raw : String(raw))
    })
    socket.on('close', () => {
      context.realtime.removeClient(clientId)
      context.logger.info('WS 已断开', { clientId, clients: context.realtime.clientCount() })
    })
    socket.on('error', (cause: unknown) => {
      context.logger.warn('WS 连接错误', { clientId, message: cause instanceof Error ? cause.message : String(cause) })
    })
  })
}
