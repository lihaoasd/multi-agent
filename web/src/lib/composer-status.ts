/**
 * 输入框上方的「现在在干什么」（S42/D45）。
 *
 * 起因（用户口径）："对话框里需要有个等待交互，让用户知道现在正在调用工具，还是模型。"
 * 此前只有会话流底部一行 `状态：working｜排队 0 条`——既看不出"在调工具"还是"在生成"，
 * 也不显眼。这里把可判定的信号合成一句话：状态投影（`state`/`waitingFor`/`paused`/`queued`）
 * + 会话事件尾巴（未闭合的 `tool_call`）+ 流式增量是否在来（`message.chunk`）。
 *
 * 纯函数、node 侧可单测（沿用 S23/S26/S28/S33/S35/S37/S38/S39/S41 的做法），组件只做映射。
 */

import { toolNameOf, type EventLike } from './event-display'

export interface ComposerStatusLike {
  readonly state: string
  readonly waitingFor?: 'question' | 'approval' | null
  readonly paused: boolean
  readonly queued: number
}

export interface ComposerStatusInput {
  /** 该会话所属 Agent 的状态投影（左栏/节点同源） */
  readonly status: ComposerStatusLike | undefined
  /** 当前会话事件（按 seq 升序；用于找"正在调用但还没有结果"的工具） */
  readonly events: readonly EventLike[]
  /** 最近是否收到流式增量（`message.chunk`）——模型正在往外吐字 */
  readonly streaming: boolean
  /** 本会话是否有待答复询问（S32 的答复卡是否显示） */
  readonly hasPendingQuestion: boolean
}

export interface ComposerStatus {
  readonly text: string
  /** `idle`（排队等） / `working`（在跑） / `waiting`（等用户） / `paused` */
  readonly tone: 'idle' | 'working' | 'waiting' | 'paused'
  /** 是否显示转圈（只有"正在跑"才转） */
  readonly spinner: boolean
}

/**
 * 找出"已经发起、但还没有对应结果"的工具调用；没有则返回 `null`。
 * 只往回看到最近的 `turn_end`/`message` 为止（同一回合内的未闭合调用）。
 */
export function openToolCall(events: readonly EventLike[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.kind === 'tool_call') {
      const callId = event.payload['callId']
      const closed =
        callId !== undefined &&
        events.slice(index + 1).some((later) => later.kind === 'tool_result' && later.payload['callId'] === callId)
      return closed ? null : toolNameOf(event)
    }
    // 回合收尾 / 已经把结论说出来 → 之前那轮工具早已结束
    if (event.kind === 'turn_end' || event.kind === 'message') return null
  }
  return null
}

/** 现在在干什么：返回一句话 + 语气 + 是否转圈；空闲且无排队时返回 `null`（不占版面） */
export function composerStatus(input: ComposerStatusInput): ComposerStatus | null {
  const status = input.status
  if (status?.paused === true) {
    return { text: '已暂停：不再领新活（恢复后继续处理队列）', tone: 'paused', spinner: false }
  }
  if (status?.state === 'waiting' || input.hasPendingQuestion) {
    if (status?.waitingFor === 'approval') return { text: '等待你的审批', tone: 'waiting', spinner: false }
    return { text: '等待你的答复（在下方答复卡里作答）', tone: 'waiting', spinner: false }
  }
  if (status?.state === 'working') {
    const tool = openToolCall(input.events)
    if (tool !== null) return { text: `正在调用工具 ${tool}…`, tone: 'working', spinner: true }
    if (input.streaming) return { text: '模型正在输出…', tone: 'working', spinner: true }
    return { text: '模型正在思考…', tone: 'working', spinner: true }
  }
  const queued = status?.queued ?? 0
  if (queued > 0) return { text: `排队 ${queued} 条，稍后处理`, tone: 'idle', spinner: false }
  return null
}
