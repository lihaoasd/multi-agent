/**
 * 会话历史构建（P3g 从 `loop-runner.ts` 抽出，2026-09-14）。
 *
 * 把持久化日志窗口转成发给模型的对话消息。两条与产品语义直接相关的规则：
 *
 *  1. **别人的发言要看得见**：会议/多角色场景下，其他 Agent 的发言以
 *     `【名字（实例id）发言】` 注入为 user 消息——否则会议里互相听不见
 *     （主持人会说"没能读到成员发言"）。
 *  2. **平台系统消息标注来源**：`payload.system === true` 或 sender 为 `system`
 *     的消息以 `【系统】` 前缀注入，避免模型误当作用户本人的话。
 *
 * 只保留 `kind === 'message'` 的事件；thought/tool/plan 等过程事件不进历史。
 * 行为与原实现逐字一致。
 */
import type { ChatMessage } from '../../infra/model/provider.js'
import type { SessionLogEvent } from '../../shared/types/session.js'

/** 名册成员的最小投影（只需要实例 id 与显示名）。 */
export interface HistoryMember {
  instanceId: string
  displayName: string
}

export interface BuildHistoryInput {
  /** 会话日志窗口（`readTail` 的结果，按 seq 升序） */
  window: SessionLogEvent[]
  /** 当前发言的实例 id（用于区分"自己的历史"与"他人发言"） */
  selfInstanceId: string
  /** 团队名册（把他人实例 id 渲染成显示名） */
  assignableMembers: HistoryMember[]
}

export function buildHistory(input: BuildHistoryInput): ChatMessage[] {
  const { window, selfInstanceId, assignableMembers } = input
  // 会议/多角色场景：**别人的发言也要看到**（否则会议里互相听不见，主持人会说"没能读到成员发言"）
  const otherSpeakers = new Set(
    window
      .filter((e) => e.kind === 'message' && e.role === 'agent' && e.sender !== selfInstanceId)
      .map((e) => String(e.sender)),
  )
  const names = new Map<string, string>()
  for (const m of assignableMembers) names.set(m.instanceId, m.displayName)
  const out: ChatMessage[] = []
  for (const e of window) {
    if (e.kind !== 'message') continue
    if (e.role === 'user' && e.content) {
      // 平台注入的系统消息（会议开场/邀请/唤醒）标注来源，避免被当成用户本人的话
      const system = e.payload?.system === true || e.sender === 'system'
      out.push({ role: 'user', content: system ? `【系统】${e.content.text}` : e.content.text })
    } else if (e.role === 'agent' && e.content) {
      if (e.sender === selfInstanceId) {
        out.push({ role: 'assistant', content: e.content.text })
      } else if (otherSpeakers.has(String(e.sender))) {
        const who = names.get(String(e.sender)) ?? String(e.sender)
        out.push({
          role: 'user',
          content: `【${who}（${String(e.sender)}）发言】${e.content.text}`,
        })
      }
    }
  }
  return out
}
