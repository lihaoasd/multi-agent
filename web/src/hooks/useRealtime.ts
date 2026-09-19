import { useCallback, useEffect, useRef, useState } from 'react'

export interface RealtimeFrame {
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface RealtimeState {
  readonly connected: boolean
  /** 启动以来收到的帧数（**按 ~500ms 节流**更新，仅供状态/调试显示；不要指望它实时） */
  readonly frameCount: number
  send(frame: { type: string; payload?: Record<string, unknown> }): void
}

/** 帧计数的刷新节流（S48/D51）：`message.chunk` 可达每秒上百帧，计数器绝不能按帧 setState */
const COUNT_THROTTLE_MS = 500

/**
 * WS 客户端（contract.md §3）：连接 `/ws?projectId=…`，重连退避，帧直接交给 `onFrame`。
 *
 * ⚠️ **S48/D51（性能事故修复）**：原先每收到一帧就 `setFrames([...prev, frame])`——
 * 而流式输出时 `message.chunk` 可达 **150+ 帧/秒**，等于每秒上百次 state 更新 + 数组复制 +
 * 整个页面重渲染（会话流里每条消息都要重新 Markdown 解析）→ 页面卡死、按钮点不动、
 * 询问/审批卡也刷不出来（用户报"应用挂了，暂停/审批/询问都失效、不显示在前端"）。
 * 现在：**帧不进 React 状态**，直接走 handler；只保留一个节流的计数器。
 */
export function useRealtime(projectId: string | null, onFrame?: (frame: RealtimeFrame) => void): RealtimeState {
  const [connected, setConnected] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)
  const handlerRef = useRef(onFrame)
  handlerRef.current = onFrame
  const countRef = useRef(0)
  const lastFlushRef = useRef(0)

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
        let frame: RealtimeFrame
        try {
          frame = JSON.parse(event.data) as RealtimeFrame
        } catch {
          return // 坏帧忽略
        }
        // 关键：**不 setState**，直接把帧交给订阅者（订阅者自己做去抖/合并）
        handlerRef.current?.(frame)
        countRef.current += 1
        const now = Date.now()
        if (now - lastFlushRef.current >= COUNT_THROTTLE_MS) {
          lastFlushRef.current = now
          setFrameCount(countRef.current)
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

  return { connected, frameCount, send }
}
