import { describe, expect, it } from 'vitest'
import { createKeyedLockManager } from '../../../src/infra/lock/keyed-lock'

describe('infra/keyed-lock', () => {
  it('同一 key 串行：后一个任务必须等前一个完成', async () => {
    const lock = createKeyedLockManager()
    const order: string[] = []

    const first = lock.withLock('k', async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first:end')
      return 1
    })
    const second = lock.withLock('k', async () => {
      order.push('second:start')
      return 2
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('不同 key 并行（互不等待）', async () => {
    const lock = createKeyedLockManager()
    const started: string[] = []
    const release: (() => void)[] = []

    const blocking = (name: string): Promise<void> =>
      lock.withLock(name, async () => {
        started.push(name)
        await new Promise<void>((resolve) => release.push(resolve))
      })

    const a = blocking('a')
    const b = blocking('b')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started.sort()).toEqual(['a', 'b'])
    for (const resolve of release) resolve()
    await Promise.all([a, b])
  })

  it('前一个任务抛错不阻塞后续任务（错误向上传播给调用者）', async () => {
    const lock = createKeyedLockManager()
    const failing = lock.withLock('k', async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    const next = await lock.withLock('k', async () => 'ok')
    expect(next).toBe('ok')
  })

  it('返回值原样透传', async () => {
    const lock = createKeyedLockManager()
    await expect(lock.withLock('k', async () => ({ id: 'p_1' }))).resolves.toEqual({ id: 'p_1' })
  })
})
