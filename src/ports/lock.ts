/**
 * 串行锁端口（abstraction.md §4.3）：把"读全量 → 改 → 覆盖写"的读改写按 key 串行化，
 * 避免同进程并发丢更新（任务槽位、manifest、归属表、编排图保存、project.json 都走它）。
 */
export interface LockManager {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
  /**
   * 非阻塞版本：key 已被占用时**立即**返回 false（用于"同一文件正被编辑"这类要报
   * `ERR_CONFLICT` 而不是排队的场景，规则 12/M5）。
   */
  tryLock<T>(key: string, fn: () => Promise<T>): Promise<{ readonly acquired: boolean; readonly value?: T }>
}
