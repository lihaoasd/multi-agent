/**
 * Agent 状态文字与颜色（S38/D41）——会话左栏、拓扑节点、运行细条**共用同一份口径**。
 *
 * 起因（用户口径）："角色询问，应该是等待回复中"。
 * 原先三处各自维护一张 `Record<state, label>`，且 `waiting` 一律显示「等待中」——
 * 既看不出在等什么（等用户答复？等审批？），也会被误读成"正在工作前的排队"。
 * 现在按 `waitingFor` 分开说：等答复 →「等待回复中」，等审批 →「等待审批中」。
 * 纯函数：node 侧可单测（沿用 S23/S26/S28/S33/S35/S37 的做法），组件只做映射。
 */

export interface AgentStatusLike {
  /** `idle` / `working` / `waiting`（未知值原样透出，便于排查） */
  readonly state: string
  /** `waiting` 时说明在等什么；缺省/`null` 表示"只是在等"（旧数据或未知原因） */
  readonly waitingFor?: 'question' | 'approval' | null
  readonly paused: boolean
}

export interface AgentStateView {
  readonly text: string
  readonly color: string
}

export const AGENT_STATE_VIEW: AgentStateView = { text: '空闲', color: 'default' }

/** 状态 → `{ text, color }`；`paused` 优先（暂停是叠加开关，压过三态） */
export function agentStateView(status: AgentStatusLike | undefined): AgentStateView {
  if (status?.paused === true) return { text: '已暂停', color: 'purple' }
  const state = status?.state ?? 'idle'
  if (state === 'waiting') {
    // 等什么要说清：询问＝等用户答复（会话窗口发送框上方就是答复入口）
    if (status?.waitingFor === 'question') return { text: '等待回复中', color: 'orange' }
    if (status?.waitingFor === 'approval') return { text: '等待审批中', color: 'gold' }
    return { text: '等待中', color: 'orange' }
  }
  if (state === 'working') return { text: '工作中', color: 'blue' }
  if (state === 'idle') return AGENT_STATE_VIEW
  return { text: state, color: 'default' }
}
