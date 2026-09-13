/**
 * 会议状态机（纯函数，domain 层；P2 归位，2026-09-14）。
 *
 * 本文件承载会议领域的**状态词汇、呈现规则与流转守卫**（零 IO、无框架依赖）：
 *   · 内部五态：queued(排队) / proposed(征询) / open / blocked_waiting_user(等你拍板) / closed
 *   · 对用户只呈现两态：**进行中 / 已结束**（2026-09-12 定稿）
 *
 * 全部已归位（P2 + P2b，2026-09-14）：状态集合与呈现派生（`meetingDisplayState` /
 * `withMeetingDisplay`）、占槽判定（`isOccupyingMeetingState`）、以及 `respond` / `askUser` /
 * `answerDecision` / `cancel` / `close` / `speakTurn` / `userInterject` 的七个流转守卫。
 */

/** 会议内部状态（五态）。 */
export const MEETING_STATES = [
  'queued',
  'proposed',
  'open',
  'blocked_waiting_user',
  'closed',
] as const
export type MeetingState = (typeof MEETING_STATES)[number]

/** 对用户呈现的两种文案。 */
export const MEETING_ACTIVE_LABEL = '进行中'
export const MEETING_CLOSED_LABEL = '已结束'

/** 占槽状态（同一时刻只允许一个会议"占槽"，其余排队）。 */
export const MEETING_OCCUPYING_STATES: MeetingState[] = ['proposed', 'open', 'blocked_waiting_user']

/** 该状态是否占用会议槽位。 */
export function isOccupyingMeetingState(state: string): boolean {
  return MEETING_OCCUPYING_STATES.includes(state as MeetingState)
}

/** 会议对用户呈现的状态：只有「进行中」和「已结束」两态。 */
export function meetingDisplayState(state: string): string {
  return state === 'closed' ? MEETING_CLOSED_LABEL : MEETING_ACTIVE_LABEL
}

/** 会议记录的最小投影（呈现派生只关心 state）。 */
export interface MeetingLike {
  state: string
}

/** 带呈现态的会议记录（REST 下发用）：state=内部子态，displayState=进行中/已结束。 */
export type WithDisplay<T> = T & {
  displayState: string
  /** 是否在排队等槽位（已发起但当前有别的会议在进行） */
  waiting: boolean
}

/** 给单条会议记录补上呈现态（进行中/已结束 + 是否排队等待）。 */
export function withMeetingDisplay<T extends MeetingLike>(rec: T): WithDisplay<T> {
  return {
    ...rec,
    displayState: meetingDisplayState(rec.state),
    waiting: rec.state === 'queued',
  }
}

// ── 流转守卫（P2b，2026-09-14 从 MeetingService 归位）────────────────────────
//
// 形态与 `task-state.ts` 一致：**返回错误码 + 文案**（null = 通过），
// 由 service 包成 `AppError`。好处：规则可单测，且错误码与中文文案逐字保留在 domain。
// 错误码用字符串字面量（与 shared/errors 的取值一致），避免 domain 依赖 shared 的具体常量对象。

/** 守卫结果：null = 通过；否则给出错误码与拒绝原因。 */
export interface MeetingGuardError {
  code: string
  message: string
}

/** 可回应邀请的状态（queued 也允许回应，但不占槽）。 */
export function canRespond(state: string): MeetingGuardError | null {
  if (state === 'proposed' || state === 'open' || state === 'queued') return null
  return { code: 'ERR_CONFLICT', message: `仅 proposed/open/queued 会议可回应邀请（当前 ${state}）` }
}

/** 成员是否可回应（在册且未回应过）。 */
export function canMemberRespond(input: {
  state: string
  member: string
  host: string
  members: string[]
  decided: boolean
}): MeetingGuardError | null {
  const base = canRespond(input.state)
  if (base) return base
  if (!input.members.includes(input.member) && input.member !== input.host) {
    return { code: 'ERR_VALIDATION', message: `成员不在本会议: ${input.member}` }
  }
  if (input.decided) {
    return { code: 'ERR_CONFLICT', message: `成员已回应: ${input.member}` }
  }
  return null
}

/** 仅主持人可在 open 会议发起决策点，且同时至多一个待答复。 */
export function canAskUser(input: {
  state: string
  asker: string
  host: string
  hasPendingDecision: boolean
}): MeetingGuardError | null {
  if (input.asker !== input.host) {
    return { code: 'ERR_FORBIDDEN_PATH', message: '仅主持人可请求用户拍板' }
  }
  if (input.state !== 'open') {
    return { code: 'ERR_CONFLICT', message: `仅 open 会议可发起决策点（当前 ${input.state}）` }
  }
  if (input.hasPendingDecision) {
    return { code: 'ERR_CONFLICT', message: '已有待答复决策点，先答复再发起下一个' }
  }
  return null
}

/** 仅在 blocked_waiting_user 状态可答复决策点。 */
export function canAnswerDecision(state: string): MeetingGuardError | null {
  if (state === 'blocked_waiting_user') return null
  return { code: 'ERR_CONFLICT', message: `当前非阻塞等待状态: ${state}` }
}

/** 仅 queued/proposed 可取消，且只有发起者或用户可取消。 */
export function canCancel(input: {
  state: string
  actor: string
  host: string
}): MeetingGuardError | null {
  if (input.state !== 'queued' && input.state !== 'proposed') {
    return { code: 'ERR_CONFLICT', message: `仅 queued/proposed 可取消（当前 ${input.state}）` }
  }
  if (input.actor !== 'user' && input.actor !== input.host) {
    return { code: 'ERR_FORBIDDEN_PATH', message: '仅发起者或用户可取消' }
  }
  return null
}

/** 仅 open 会议可点名发言，且被点名者须是参会成员（非主持人）。 */
export function canSpeakTurn(input: {
  state: string
  host: string
  caller: string
  member: string
  agents: string[]
}): MeetingGuardError | null {
  if (input.caller !== input.host) {
    return { code: 'ERR_FORBIDDEN_PATH', message: '仅主持人可点名发言' }
  }
  if (input.state !== 'open') {
    return { code: 'ERR_CONFLICT', message: `仅 open 会议可推进轮次（当前 ${input.state}）` }
  }
  const isMember = input.agents.includes(input.member) && input.member !== input.host
  if (!isMember) {
    return { code: 'ERR_VALIDATION', message: `非参会成员或为主持人: ${input.member}` }
  }
  return null
}

/** 仅 open / blocked_waiting_user 会议可插话。 */
export function canUserInterject(state: string): MeetingGuardError | null {
  if (state === 'open' || state === 'blocked_waiting_user') return null
  return { code: 'ERR_CONFLICT', message: `会议未进行（当前 ${state}）` }
}

/** 仅 open / blocked_waiting_user 会议可结束。 */
export function canClose(state: string): MeetingGuardError | null {
  if (state === 'open' || state === 'blocked_waiting_user') return null
  return { code: 'ERR_CONFLICT', message: `仅 open/blocked 会议可结束（当前 ${state}）` }
}

/** 纪要（读取/重生成/转任务）都要求会议已结束。 */
export function isMeetingClosed(state: string): boolean {
  return state === 'closed'
}
