import type { Container, Disposable, Lifetime, Token } from '../ports/container'

interface Registration<T = unknown> {
  readonly factory: (container: Container) => T
  readonly lifetime: Lifetime
}

interface ContainerState {
  readonly registrations: Map<string, Registration>
  /** singleton 在根状态中缓存：作用域共享同一实例 */
  readonly singletons: Map<string, unknown>
  /** singleton 的释放队列（只有根容器 dispose 时处理） */
  readonly singletonDisposables: unknown[]
}

function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function'
  )
}

/**
 * 轻量 DI 容器实现（abstraction.md §5）：register/resolve/scope/dispose，构造器注入。
 * 语义：
 * - `singleton` 在**根状态**缓存（作用域共享，仅根容器 dispose 时释放）；
 * - `scoped` 在各自 scope 内缓存，不跨 scope 泄漏，随该容器 dispose 释放；
 * - `transient` 每次新建，随创建它的容器 dispose 释放；
 * - 未注册依赖 → 立即抛错（编程错误），组合根用 `assertGraph` 在启动期暴露。
 */
export function createContainer(): Container {
  const state: ContainerState = {
    registrations: new Map(),
    singletons: new Map(),
    singletonDisposables: [],
  }
  return createScopedContainer(state, [], true)
}

function createScopedContainer(state: ContainerState, localCreated: unknown[], isRoot: boolean): Container {
  const scoped = new Map<string, unknown>()

  const container: Container = {
    register<T>(t: Token<T>, factory: (c: Container) => T, opts?: { lifetime?: Lifetime }): void {
      if (state.registrations.has(t.key)) {
        throw new Error(`ERR_INTERNAL: Token 重复注册：${t.key}`)
      }
      state.registrations.set(t.key, {
        factory: factory as (c: Container) => unknown,
        lifetime: opts?.lifetime ?? 'singleton',
      })
    },

    registerInstance<T>(t: Token<T>, value: T): void {
      if (state.registrations.has(t.key)) {
        throw new Error(`ERR_INTERNAL: Token 重复注册：${t.key}`)
      }
      state.registrations.set(t.key, { factory: () => value, lifetime: 'singleton' })
      state.singletons.set(t.key, value)
      if (isDisposable(value)) state.singletonDisposables.push(value)
    },

    resolve<T>(t: Token<T>): T {
      const value = container.tryResolve(t)
      if (value === undefined) {
        throw new Error(`ERR_INTERNAL: 依赖未注册：${t.key}`)
      }
      return value
    },

    tryResolve<T>(t: Token<T>): T | undefined {
      const registration = state.registrations.get(t.key)
      if (registration === undefined) return undefined

      if (registration.lifetime === 'singleton') {
        if (state.singletons.has(t.key)) return state.singletons.get(t.key) as T
        const value = registration.factory(container)
        state.singletons.set(t.key, value)
        if (isDisposable(value)) state.singletonDisposables.push(value)
        return value as T
      }

      if (registration.lifetime === 'scoped') {
        if (scoped.has(t.key)) return scoped.get(t.key) as T
        const value = registration.factory(container)
        scoped.set(t.key, value)
        if (isDisposable(value)) localCreated.push(value)
        return value as T
      }

      const value = registration.factory(container)
      if (isDisposable(value)) localCreated.push(value)
      return value as T
    },

    has<T>(t: Token<T>): boolean {
      return state.registrations.has(t.key)
    },

    createScope(): Container {
      return createScopedContainer(state, [], false)
    },

    assertGraph(tokens: readonly Token<unknown>[]): void {
      const missing = tokens.filter((t) => !state.registrations.has(t.key)).map((t) => t.key)
      if (missing.length > 0) {
        throw new Error(`ERR_INTERNAL: 组合根缺少必需依赖：${missing.join(', ')}`)
      }
    },

    async dispose(): Promise<void> {
      // 先释放本容器创建的 scoped/transient（逆序）；singleton 只由根容器释放（逆序）
      const own = [...localCreated].reverse()
      const shared = isRoot ? [...state.singletonDisposables].reverse() : []
      localCreated.length = 0
      scoped.clear()
      for (const value of [...own, ...shared]) {
        if (isDisposable(value)) await value.dispose()
      }
      if (isRoot) {
        state.singletonDisposables.length = 0
        state.singletons.clear()
      }
    },
  }

  return container
}
