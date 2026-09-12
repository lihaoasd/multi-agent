/**
 * 按 key 串行的异步锁（同一 key 的读-改-写互斥，不同 key 并行）。
 * 用于 tasks.jsonl / file-owners.jsonl 这类「读全量 → 改 → 覆盖写」的记录文件：
 * 不加锁时并发写入会互相覆盖（丢记录）。
 */
export class KeyedLock {
  private readonly locks = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(() => fn(), () => fn())
    const guard = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(key, guard)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === guard) this.locks.delete(key)
    }
  }
}
