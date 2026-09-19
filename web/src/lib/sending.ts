/**
 * "这个会话正在发送消息"的按会话标记（S46/D49）。
 *
 * 起因（用户报告）："不同角色间的会话是独立的，现在角色发送消息后，其他角色发不了。"
 * 根因：`POST /sessions/:sid/messages` 在服务端会 `await drain(...)`——**整个回合跑完才响应**
 * （模型调用 + 工具，可能几十秒）；而会话面板原来用一个**全局** `busy` 控制发送按钮的 `loading`，
 * 于是给 A 发消息后（按钮一直转圈），切到 B 的会话时按钮仍处于 loading（antd 转圈期间点击无效），
 * B 就发不出消息了。会话本来就该各自独立——发送中标记也必须**按会话**记。
 *
 * 纯函数、node 侧可单测（沿用 S23/S26/S28/S33/S35/S37/S38/S39/S41/S42/S45 的做法）。
 */

/** 该会话是否正在发送（`sessionId` 为空视为否） */
export function isSending(sending: readonly string[], sessionId: string | null): boolean {
  return sessionId !== null && sessionId.length > 0 && sending.includes(sessionId)
}

/** 标记该会话开始发送（幂等，不改原数组） */
export function withSending(sending: readonly string[], sessionId: string): readonly string[] {
  return sending.includes(sessionId) ? sending : [...sending, sessionId]
}

/** 清除该会话的发送标记（幂等，不改原数组） */
export function withoutSending(sending: readonly string[], sessionId: string): readonly string[] {
  return sending.includes(sessionId) ? sending.filter((item) => item !== sessionId) : sending
}
