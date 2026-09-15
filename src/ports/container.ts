/**
 * DI 容器端口（真源：docs/design/abstraction.md §5）。
 * 只有 bootstrap 组合根负责装配；业务代码通过构造器接收依赖，不用服务定位器。
 */

/** 类型令牌：键名与接口名一致，`__type` 仅用于类型推导（运行期不存在） */
export interface Token<T> {
  readonly key: string
  readonly __type?: T
}

export function token<T>(key: string): Token<T> {
  return { key }
}

export type Lifetime = 'singleton' | 'scoped' | 'transient'

export interface Disposable {
  dispose(): Promise<void> | void
}

export interface Container {
  register<T>(t: Token<T>, factory: (c: Container) => T, opts?: { readonly lifetime?: Lifetime }): void
  registerInstance<T>(t: Token<T>, value: T): void
  /** 未注册 → 抛错（编程错误，启动期即应通过 assertGraph 暴露） */
  resolve<T>(t: Token<T>): T
  tryResolve<T>(t: Token<T>): T | undefined
  has<T>(t: Token<T>): boolean
  /** per-turn / per-request 作用域：共享注册表与 singleton，自有 scoped 实例 */
  createScope(): Container
  /** 启动期自检：任一必需 Token 缺失即抛错（组合根最后一步） */
  assertGraph(tokens: readonly Token<unknown>[]): void
  /** 逆序释放已创建且实现 Disposable 的实例 */
  dispose(): Promise<void>
}
