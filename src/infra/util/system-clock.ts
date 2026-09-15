import type { Clock } from '../../ports/clock'

/** 系统时钟（唯一允许直接读当前时间的地方之一；domain/application 通过端口取时间） */
export const systemClock: Clock = {
  now: () => new Date(),
}

/** 固定时钟（测试用）：时间可推进 */
export function createFixedClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): Clock & {
  advance(ms: number): void
  set(at: Date): void
} {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
    set: (at: Date) => {
      current = at
    },
  }
}
