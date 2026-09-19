/**
 * 时间显示（S39/D42）——界面上的钟点一律走这里，**用本地时间**。
 *
 * 起因（用户报告）："trace 的时间显示不对"。
 * 原实现是 `ts.slice(11, 23)`——把 ISO 串（`…T13:35:02.104Z`，**UTC**）当本地时间直接切出来，
 * UTC+8 的机器上整整差 8 小时；任务列表的 `updatedAt.slice(11, 19)` 是同一处伤。
 *
 * 纯函数、无依赖：node 侧可单测（沿用 S23/S26/S28/S33/S35/S37/S38 的做法）。
 */

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** 本地墙钟 `HH:MM:SS`（`withMs:false`）或 `HH:MM:SS.mmm`（默认） */
export function localClock(ts: string | undefined, options: { readonly withMs?: boolean } = {}): string {
  if (ts === undefined || ts.length === 0) return ''
  const date = new Date(ts)
  // 不可解析就原样给出，便于排查（不要伪造一个"看起来对"的时间）
  if (Number.isNaN(date.getTime())) return ts
  const clock = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`
  return options.withMs === false ? clock : `${clock}.${pad(date.getMilliseconds(), 3)}`
}
