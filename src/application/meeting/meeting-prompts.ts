/**
 * 会议提示词与触达文案（**纯函数**，P3 从 `composition.ts` 抽出，2026-09-14）。
 *
 * 为什么抽出来：这些文案原先内联在组合根的 `runMeetingChain` / `meetingInviteText` 里，
 * 让"依赖装配"这个文件同时承担了业务文案。抽成纯函数后：
 *   · 不依赖任何服务/store，可单独断言；
 *   · 组合根只保留"何时发、发给谁"的编排。
 *
 * **文案内容与原实现逐字一致**——改字即行为变更，不属于纯重构。
 */

/** 会议的最小投影（文案只需要主题/描述/主持人/状态）。 */
export interface MeetingBrief {
  topic: string
  desc?: string | null
  host: string
  /** 内部状态（`queued` 时邀请文案要说明"排队等待"） */
  state: string
}

/** 被搁置的事项（散会后回注用；形状与 `ShedRecord` 的对应字段一致）。 */
export interface ShedBrief {
  questions: Array<{ id: string; question: string }>
  approvals: Array<{ id: string; summary: string }>
}

/** 主持人开场提示。 */
export function meetingHostOpenPrompt(input: {
  host: string
  topic: string
  desc: string
  members: string[]
}): string {
  const { host, topic, desc, members } = input
  return (
    `【会议开场】你是主持人（${host}）。会议主题「${topic}」` +
    (desc ? `，描述：${desc}` : '') +
    `，参会：${members.join('、')} 与用户。请先开场：说明议题与期望产出；` +
    '然后可用 meeting_talk 逐个点名成员发言（他们的发言会写进会议会话）。'
  )
}

/** 主持人收尾提示。 */
export function meetingHostWrapPrompt(input: { topic: string }): string {
  return (
    `【会议收尾】会议「${input.topic}」的成员发言已写入会议会话。请阅读后给出：结论、待办（谁做什么）、` +
    '仍需用户拍板的事项；如需结束会议可调用 meeting_close。'
  )
}

/** 请某位成员在会议中发言的提示。 */
export function meetingMemberSpeakPrompt(input: {
  host: string
  topic: string
  desc: string
}): string {
  const { host, topic, desc } = input
  return (
    `【会议邀请】${host} 邀请你参加「${topic}」` +
    (desc ? `（${desc}）` : '') +
    '。请在会议中发表意见：结论 + 理由 + 需要谁配合（简明，不要复述别人）。'
  )
}

/**
 * 入会通知文本：刚被邀请（`invited`）与排队轮到正式开始（`started`）两种。
 */
export function meetingInviteText(meeting: MeetingBrief, kind: 'invited' | 'started'): string {
  const topic = meeting.topic
  const desc = meeting.desc?.trim()
  if (kind === 'started') {
    return (
      `【会议开始】${meeting.host} 邀请的会议「${topic}」现在开始` +
      `${desc ? `：${desc}` : ''}。\n会议已开始，你的团队状态已是「会议中」。` +
      '你**本轮不用动手**：等主持人开场后点名发言即可（发言写进会议会话）。'
    )
  }
  const queued = meeting.state === 'queued'
  return (
    `【会议邀请】${meeting.host} 拉你参加「${topic}」${desc ? `：${desc}` : ''}。\n` +
    (queued
      ? '当前有别的会议在进行，本场**排队等待**中，轮到时平台会自动开始并在这里通知你。'
      : '会议已开始，你的团队状态已是「会议中」。') +
    '你**本轮不用动手**：等主持人开场后点名发言即可（发言写进会议会话）。'
  )
}

/**
 * 散会后回注给参会者的「会议结论 + 被搁置事项 + 续跑指引」全文。
 *
 * 角色看到它就会被唤醒续跑一轮，带着会议结论继续做（用户选择的"自动续跑"）。
 */
export function meetingWrapUpText(meetingId: string, minutes: string, shed: ShedBrief[]): string {
  const droppedQ = shed.flatMap((s) => s.questions)
  const droppedA = shed.flatMap((s) => s.approvals)
  const lines = [`【会议结论】会议 ${meetingId} 已结束，纪要如下：`, minutes, '']
  if (droppedQ.length || droppedA.length) {
    lines.push('【入会时被搁置的事项】你开会前正在等用户处理，现已被搁置（提问作废、审批作废）：')
    for (const q of droppedQ) lines.push(`- 询问用户「${q.question}」（提问 ${q.id}，已作废）`)
    for (const a of droppedA) lines.push(`- 待批操作「${a.summary}」（审批 ${a.id}，已作废）`)
    lines.push('这些事项**不会再有用户答复**：请结合上面的会议结论重新判断，不要等待原答复。')
  }
  lines.push(
    '',
    '请据此**继续推进你手上的任务**：若会议结论已覆盖原疑问，直接按结论执行；' +
      '若仍需用户拍板，重新用 ask_user 提问（可带上会议结论作为背景）；' +
      '若任务状态有变化，用 task_update 上报。',
  )
  return lines.join('\n')
}
