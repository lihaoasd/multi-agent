import { describe, expect, it } from 'vitest'
import { createIdGenerator } from '../../../src/infra/util/id'
import { createLogger, createMemorySink } from '../../../src/infra/util/logger'

describe('infra/util · id', () => {
  it('格式为 <prefix>_<时间36进制><随机后缀>，可注入确定性来源', () => {
    const ids = createIdGenerator({ now: () => 1_700_000_000_000, random: () => 0 })
    expect(ids.next('p')).toBe(`p_${(1_700_000_000_000).toString(36)}00000`)
    expect(ids.next('t')).toMatch(/^t_[0-9a-z]{5,}$/)
  })

  it('随机源不同则 id 不同，前缀互不影响', () => {
    let seed = 0
    const ids = createIdGenerator({ now: () => 1, random: () => (seed += 0.1) })
    const first = ids.next('s')
    const second = ids.next('s')
    expect(first).not.toBe(second)
    expect(first.startsWith('s_')).toBe(true)
    expect(ids.next('q').startsWith('q_')).toBe(true)
  })
})

describe('infra/util · logger', () => {
  it('输出单行 JSON，包含时间/级别/消息与字段', () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink, now: () => new Date('2026-09-15T00:00:00.000Z') })
    logger.info('服务已启动', { port: 3000 })

    const lines = sink.lines()
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(record).toEqual({
      ts: '2026-09-15T00:00:00.000Z',
      level: 'info',
      msg: '服务已启动',
      port: 3000,
    })
  })

  it('按级别过滤：debug 在 info 阈值下不输出', () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink, level: 'warn' })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(sink.lines()).toHaveLength(2)
  })

  it('child 合并固定字段，且不污染父 logger', () => {
    const sink = createMemorySink()
    const root = createLogger({ sink, base: { app: 'agent-haness' } })
    const child = root.child({ projectId: 'p_1' })
    child.info('子日志')
    root.info('父日志')

    const [childRecord, parentRecord] = sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(childRecord).toMatchObject({ app: 'agent-haness', projectId: 'p_1', msg: '子日志' })
    expect(parentRecord).toMatchObject({ app: 'agent-haness', msg: '父日志' })
    expect(parentRecord?.['projectId']).toBeUndefined()
  })
})
