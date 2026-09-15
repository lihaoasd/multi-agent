import { useCallback, useEffect, useRef, useState } from 'react'

export interface RealtimeFrame {
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface RealtimeState {
  readonly connected: boolean
  /** 最近收到的帧（含历史，最多保留 200 条） */
  readonly frames: readonly RealtimeFrame[]
  send(frame: { type: string; payload?: Record<string, unknown> }): void
}

const MAX_FRAMES = 200

/**
 * WS 客户端（contract.md §3）：连接 `/ws?projectId=…`，重连退避，帧缓冲供 UI 读取。
 * 注意：服务端只在事件**落盘后**才推送（先盘后推），因此前端无需去重也能保证顺序。
 */
export function useRealtime(projectId: string | null, onFrame?: (frame: RealtimeFrame) => void): RealtimeState {
  const [connected, setConnected] = useState(false)
  const [frames, setFrames] = useState<readonly RealtimeFrame[]>([])
  const socketRef = useRef<WebSocket | null>(null)
  const handlerRef = useRef(onFrame)
  handlerRef.current = onFrame

  useEffect(() => {
    if (projectId === null) return
    let disposed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws?projectId=${encodeURIComponent(projectId)}`)
      socketRef.current = socket

      socket.onopen = () => {
        retry = 0
        setConnected(true)
      }
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(event.data) as RealtimeFrame
          setFrames((previous) => [...previous.slice(-(MAX_FRAMES - 1)), frame])
          handlerRef.current?.(frame)
        } catch {
          // 坏帧忽略
        }
      }
      socket.onclose = () => {
        setConnected(false)
        if (disposed) return
        retry += 1
        timer = setTimeout(connect, Math.min(1000 * retry, 5000))
      }
      socket.onerror = () => {
        socket.close()
      }
    }

    connect()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      socketRef.current?.close()
      socketRef.current = null
      setConnected(false)
    }
  }, [projectId])

  const send = useCallback((frame: { type: string; payload?: Record<string, unknown> }): void => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: frame.type, payload: frame.payload ?? {} }))
  }, [])

  return { connected, frames, send }
}
