import { describe, expect, it } from 'vitest'
import { createContainer } from '../../../src/bootstrap/container'
import { token, type Disposable } from '../../../src/ports/container'

interface Counter {
  value: number
}

const A = token<Counter>('A')
const B = token<Counter>('B')
const MISSING = token<Counter>('MISSING')

describe('bootstrap/container · 生命周期', () => {
  it('singleton 只构造一次，scoped 在各自作用域内共享，transient 每次新建', () => {
    const container = createContainer()
    let singletonBuilds = 0
    let scopedBuilds = 0
    let transientBuilds = 0

    container.register(A, () => ({ value: ++singletonBuilds }))
    container.register(B, () => ({ value: ++scopedBuilds }), { lifetime: 'scoped' })
    container.register(token<Counter>('T'), () => ({ value: ++transientBuilds }), { lifetime: 'transient' })

    const T = token<Counter>('T')
    const scope1 = container.createScope()
    const scope2 = container.createScope()

    expect(container.resolve(A).value).toBe(1)
    expect(scope1.resolve(A).value).toBe(1)
    expect(scope2.resolve(A).value).toBe(1)
    expect(singletonBuilds).toBe(1)

    expect(scope1.resolve(B).value).toBe(1)
    expect(scope1.resolve(B).value).toBe(1)
    expect(scope2.resolve(B).value).toBe(2)
    expect(scopedBuilds).toBe(2)

    expect(scope1.resolve(T).value).toBe(1)
    expect(scope1.resolve(T).value).toBe(2)
    expect(transientBuilds).toBe(2)
  })

  it('registerInstance 直接返回同一对象', () => {
    const container = createContainer()
    const instance = { value: 42 }
    container.registerInstance(A, instance)
    expect(container.resolve(A)).toBe(instance)
    expect(container.resolve(A)).toBe(instance)
  })

  it('未注册依赖：tryResolve 返回 undefined，resolve 抛错', () => {
    const container = createContainer()
    expect(container.has(MISSING)).toBe(false)
    expect(container.tryResolve(MISSING)).toBeUndefined()
    expect(() => container.resolve(MISSING)).toThrow(/依赖未注册：MISSING/)
  })

  it('重复注册同一 Token 视为编程错误', () => {
    const container = createContainer()
    container.register(A, () => ({ value: 1 }))
    expect(() => container.register(A, () => ({ value: 2 }))).toThrow(/重复注册：A/)
  })

  it('assertGraph 列出缺失依赖', () => {
    const container = createContainer()
    container.register(A, () => ({ value: 1 }))
    expect(() => container.assertGraph([A, MISSING])).toThrow(/缺少必需依赖：MISSING/)
    expect(() => container.assertGraph([A])).not.toThrow()
  })

  it('dispose 逆序释放实现 Disposable 的实例（重复 resolve 不重复释放）', async () => {
    const container = createContainer()
    const disposed: string[] = []
    const make = (name: string): Disposable & Counter => ({
      value: 0,
      dispose: () => {
        disposed.push(name)
      },
    })
    container.register(A, () => make('A'))
    container.register(B, () => make('B'), { lifetime: 'scoped' })

    container.resolve(A)
    container.resolve(A)
    container.resolve(B)
    await container.dispose()

    expect(disposed).toEqual(['B', 'A'])
  })

  it('作用域 dispose 只释放自己创建的实例，共享 singleton 由根容器释放', async () => {
    const container = createContainer()
    const disposed: string[] = []
    const make = (name: string): Disposable & Counter => ({
      value: 0,
      dispose: () => {
        disposed.push(name)
      },
    })
    container.register(A, () => make('A'))
    container.register(B, () => make('B'), { lifetime: 'scoped' })

    const scope = container.createScope()
    scope.resolve(A)
    scope.resolve(B)
    await scope.dispose()
    expect(disposed).toEqual(['B'])

    await container.dispose()
    expect(disposed).toEqual(['B', 'A'])
  })
})
