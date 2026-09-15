import type { LockManager } from '../../ports/lock'

/**
 * 进程内 KeyedLock：同一 key 的读改写串行，不同 key 并行。
 * 实现要点：每条链尾挂一个 promise，新任务接在链尾；无论成败都释放（不阻塞后续）。
 * 说明：单进程内有效；P2 多进程时替换为文件锁（端口不变）。
 */
export function createKeyedLockManager(): LockManager {
  const tails = new Map<string, Promise<unknown>>()
  const held = new Set<string>()

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.then(fn, fn)
      // 链尾只关心"完成"，不传播错误（否则后续任务会被前一个失败牵连）
      const tail = run.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      try {
        return await run
      } finally {
        if (tails.get(key) === tail) tails.delete(key)
      }
    },

    async tryLock<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
      if (held.has(key)) return { acquired: false }
      held.add(key)
      try {
        return { acquired: true, value: await fn() }
      } finally {
        held.delete(key)
      }
    },
  }
}
