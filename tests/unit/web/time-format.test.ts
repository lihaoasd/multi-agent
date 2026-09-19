import { describe, expect, it } from 'vitest'
import { localClock } from '../../../web/src/lib/time-format'

/**
 * S39/D42：用户报告"trace 的时间显示不对"——原实现 `iso.slice(11, 23)` 把 UTC 当本地时间显示
 * （UTC+8 差 8 小时）。这里用**与时区无关**的不变量钉住它：
 * 同一个时刻的不同 ISO 写法（`Z` 与 `+08:00`）必须渲染出**同一个**本地钟点——
 * 旧实现给出 11:52 与 19:52 两个不同答案，必然失败。
 */
describe('time-format · 本地时间显示', () => {
  it('同一时刻的不同时区写法 → 同一个本地钟点（旧实现会差 8 小时）', () => {
    const clockZ = localClock('2026-09-17T11:52:29.007Z')
    const clockOffset = localClock('2026-09-17T19:52:29.007+08:00')
    expect(clockZ).toBe(clockOffset)
    expect(clockZ).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('按本地墙钟渲染（与 Date 的本地读数一致，不是 UTC 读数）', () => {
    const iso = '2026-09-17T11:52:29.007Z'
    const date = new Date(iso)
    const pad = (value: number, width: number): string => String(value).padStart(width, '0')
    expect(localClock(iso)).toBe(
      `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`,
    )
  })

  it('`withMs:false` 给任务列表用的 `HH:MM:SS`', () => {
    expect(localClock('2026-09-17T11:52:29.007Z', { withMs: false })).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('缺失 / 空串 → 空；不可解析 → 原样返回（不伪造时间）', () => {
    expect(localClock(undefined)).toBe('')
    expect(localClock('')).toBe('')
    expect(localClock('不是时间')).toBe('不是时间')
  })

  it('无时区标记的串按本地时间解释（ISO 语义）', () => {
    expect(localClock('2026-09-17T08:05:00', { withMs: false })).toBe('08:05:00')
  })
})
