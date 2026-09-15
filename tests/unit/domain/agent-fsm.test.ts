import { describe, expect, it } from 'vitest'
import {
  applyAgentEvent,
  canAcceptWork,
  IDLE_AGENT,
  isOccupied,
  type AgentRuntime,
} from '../../../src/domain/fsm/agent'
import { isErr, unwrapOrThrow } from '../../../src/shared/result'

function apply(runtime: AgentRuntime, ...events: Parameters<typeof applyAgentEvent>[1][]): AgentRuntime {
  return events.reduce((current, event) => unwrapOrThrow(applyAgentEvent(current, event)), runtime)
}

describe('domain/fsm/agent · 正常流转', () => {
  it('idle --wake--> working --await--> waiting --resume--> working --settle--> idle', () => {
    const working = apply(IDLE_AGENT, { type: 'wake' })
    expect(working).toEqual({ state: 'working', paused: false })

    const waiting = apply(working, { type: 'await' })
    expect(waiting.state).toBe('waiting')

    const resumed = apply(waiting, { type: 'resume' })
    expect(resumed.state).toBe('working')

    expect(apply(resumed, { type: 'settle' })).toEqual(IDLE_AGENT)
  })

  it('waiting 可直接 settle（询问取消/审批过期后释放槽位）', () => {
    const waiting = apply(IDLE_AGENT, { type: 'wake' }, { type: 'await' })
    expect(apply(waiting, { type: 'settle' }).state).toBe('idle')
  })

  it('单工判定：working/waiting 均占用槽位', () => {
    expect(isOccupied(IDLE_AGENT)).toBe(false)
    expect(isOccupied(apply(IDLE_AGENT, { type: 'wake' }))).toBe(true)
    expect(isOccupied(apply(IDLE_AGENT, { type: 'wake' }, { type: 'await' }))).toBe(true)
    expect(canAcceptWork(IDLE_AGENT)).toBe(true)
  })
})

describe('domain/fsm/agent · 非法流转（ERR_CONFLICT，无静默状态变更）', () => {
  const cases: ReadonlyArray<readonly [string, AgentRuntime, Parameters<typeof applyAgentEvent>[1]['type']]> = [
    ['idle 不能 await', IDLE_AGENT, 'await'],
    ['idle 不能 resume', IDLE_AGENT, 'resume'],
    ['idle 不能 settle', IDLE_AGENT, 'settle'],
    ['working 不能重复 wake', { state: 'working', paused: false }, 'wake'],
    ['working 不能 resume', { state: 'working', paused: false }, 'resume'],
    ['waiting 不能 wake', { state: 'waiting', paused: false }, 'wake'],
    ['waiting 不能 await', { state: 'waiting', paused: false }, 'await'],
  ]

  it.each(cases)('%s', (_title, runtime, eventType) => {
    const result = applyAgentEvent(runtime, { type: eventType } as Parameters<typeof applyAgentEvent>[1])
    expect(isErr(result)).toBe(true)
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_CONFLICT')
      expect(result.error.detail).toEqual({ state: runtime.state })
    }
  })
})

describe('domain/fsm/agent · 暂停叠加语义（D19-⑥）', () => {
  it('暂停后拒绝 wake，但回合内收尾流转照常', () => {
    const paused = unwrapOrThrow(applyAgentEvent(IDLE_AGENT, { type: 'pause' }))
    expect(paused).toEqual({ state: 'idle', paused: true })
    expect(canAcceptWork(paused)).toBe(false)

    const rejected = applyAgentEvent(paused, { type: 'wake' })
    expect(isErr(rejected)).toBe(true)
    if (!rejected.ok) expect(rejected.error.code).toBe('ERR_CONFLICT')

    // 暂停发生在工作中：当前回合仍可 await / settle
    const pausedWorking = unwrapOrThrow(applyAgentEvent({ state: 'working', paused: false }, { type: 'pause' }))
    const waiting = unwrapOrThrow(applyAgentEvent(pausedWorking, { type: 'await' }))
    expect(waiting).toEqual({ state: 'waiting', paused: true })
    const settled = unwrapOrThrow(applyAgentEvent(waiting, { type: 'settle' }))
    expect(settled).toEqual({ state: 'idle', paused: true })
  })

  it('pause/unpause 幂等（运行控制可重复点击）', () => {
    const first = unwrapOrThrow(applyAgentEvent(IDLE_AGENT, { type: 'pause' }))
    const second = unwrapOrThrow(applyAgentEvent(first, { type: 'pause' }))
    expect(second).toBe(first)

    const resumed = unwrapOrThrow(applyAgentEvent(second, { type: 'unpause' }))
    expect(resumed).toEqual(IDLE_AGENT)
    expect(unwrapOrThrow(applyAgentEvent(resumed, { type: 'unpause' }))).toBe(resumed)
  })

  it('恢复后可以重新领活', () => {
    const runtime = apply(IDLE_AGENT, { type: 'pause' }, { type: 'unpause' }, { type: 'wake' })
    expect(runtime).toEqual({ state: 'working', paused: false })
    expect(canAcceptWork(runtime)).toBe(false)
  })
})
