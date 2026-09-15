/**
 * 串行锁端口（abstraction.md §4.3）：把"读全量 → 改 → 覆盖写"的读改写按 key 串行化，
 * 避免同进程并发丢更新（任务槽位、manifest、归属表、编排图保存、project.json 都走它）。
 */
export interface LockManager {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}
