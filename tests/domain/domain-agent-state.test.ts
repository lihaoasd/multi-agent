/**
 * 特征化测试 · 角色运行态推导（重构 P0-4，2026-09-14）。
 *
 * 目的：**锁定现状行为**。`deriveAgentState` 已在 P2 从 `application/runtime-state.ts`
 * 搬迁到 `domain/fsm/agent-state.ts`；搬迁前的特征化断言原样保留，
 * 任何搬迁引入的行为漂移都会在这里失败。
 *
 * 不变量来源：`docs/design/agent-runtime.md` §2 两级状态映射
 *   停用 > 会议中 > 等待你处理 > 工作中 > 空闲
 */
import { describe, expect, it } from 'vitest'

import { deriveAgentState, type AgentStateInput } from '../../src/domain/fsm/agent-state.js'

/** 构造推导输入（默认：启用、无占用、无待办）。 */
function input(over: Partial<AgentStateInput> = {}): AgentStateInput {
  return {
    enabled: true,
    occupancy: null,
    hasPendingApproval: false,
    hasPendingQuestion: false,
    ...over,
  }
}

/** occupancy 的最小投影（推导只用到 activity）。 */
function occ(activity: 'working' | 'meeting' | 'waiting') {
  return { sessionId: 'u_dev_1', activity, since: '' }
}

describe('deriveAgentState（角色运行态单点推导）', () => {
  it('无占用、无待办 → idle', () => {
    expect(deriveAgentState(input())).toBe('idle')
  })

  it('停用优先于一切：即使会议中 + 有待答提问，也是 disabled', () => {
    expect(
      deriveAgentState(
        input({
          enabled: false,
          occupancy: occ('meeting'),
          hasPendingApproval: true,
          hasPendingQuestion: true,
        }),
      ),
    ).toBe('disabled')
  })

  it('会议中优先于 waiting：在会成员即使有待批审批，仍显示 meeting', () => {
    expect(
      deriveAgentState(input({ occupancy: occ('meeting'), hasPendingApproval: true })),
    ).toBe('meeting')
    expect(
      deriveAgentState(input({ occupancy: occ('meeting'), hasPendingQuestion: true })),
    ).toBe('meeting')
  })

  it('waiting 压过 working：有待答提问时，工作中也要显示等待你处理', () => {
    expect(deriveAgentState(input({ occupancy: occ('working'), hasPendingQuestion: true }))).toBe(
      'waiting',
    )
  })

  it('waiting 压过 working：有待批审批同样如此', () => {
    expect(deriveAgentState(input({ occupancy: occ('working'), hasPendingApproval: true }))).toBe(
      'waiting',
    )
  })

  it('无占用但有待答提问 → waiting（不是 idle）', () => {
    expect(deriveAgentState(input({ hasPendingQuestion: true }))).toBe('waiting')
  })

  it('工作占用且无待办 → working', () => {
    expect(deriveAgentState(input({ occupancy: occ('working') }))).toBe('working')
  })

  it('occupancy.activity 为 waiting 且无待办标志 → 仍按占用链路返回 idle（现状）', () => {
    // 现状：deriveAgentState 只识别 activity==='meeting' 与 'working'，
    // occupancy 里的 'waiting' 不参与推导（waiting 状态由 pending 提问/审批标志决定）。
    expect(deriveAgentState(input({ occupancy: occ('waiting') }))).toBe('idle')
  })

  it('occupancy 为 null 且无待办 → idle', () => {
    expect(deriveAgentState(input({ occupancy: null }))).toBe('idle')
  })

  it('优先级全序：disabled > meeting > waiting > working > idle', () => {
    // 逐个组合验证"高优先级总能压过所有低优先级条件"
    expect(deriveAgentState(input({ enabled: false }))).toBe('disabled')
    expect(deriveAgentState(input({ occupancy: occ('meeting') }))).toBe('meeting')
    expect(deriveAgentState(input({ hasPendingQuestion: true }))).toBe('waiting')
    expect(deriveAgentState(input({ occupancy: occ('working') }))).toBe('working')
    expect(deriveAgentState(input())).toBe('idle')
  })
})
