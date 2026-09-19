import { describe, expect, it } from 'vitest'
import { agentStateView } from '../../../web/src/lib/agent-state'

/** S38/D41：用户口径"角色询问，应该是等待回复中"——status 投影只说 `waiting`，界面要说清在等谁 */
describe('agent-state · 状态文字与颜色（左栏/节点/细条共用）', () => {
  const base = { state: 'idle', paused: false }

  it('等待用户答复询问 → 「等待回复中」', () => {
    expect(agentStateView({ ...base, state: 'waiting', waitingFor: 'question' })).toEqual({
      text: '等待回复中',
      color: 'orange',
    })
  })

  it('等待审批决定 → 「等待审批中」', () => {
    expect(agentStateView({ ...base, state: 'waiting', waitingFor: 'approval' })).toEqual({
      text: '等待审批中',
      color: 'gold',
    })
  })

  it('等待原因未知（旧数据/未带字段）→ 退回「等待中」', () => {
    expect(agentStateView({ ...base, state: 'waiting' })).toEqual({ text: '等待中', color: 'orange' })
    expect(agentStateView({ ...base, state: 'waiting', waitingFor: null })).toEqual({ text: '等待中', color: 'orange' })
  })

  it('工作中 / 空闲', () => {
    expect(agentStateView({ ...base, state: 'working' })).toEqual({ text: '工作中', color: 'blue' })
    expect(agentStateView(base)).toEqual({ text: '空闲', color: 'default' })
    expect(agentStateView(undefined)).toEqual({ text: '空闲', color: 'default' })
  })

  it('暂停压过三态（叠加开关，不改变状态机）', () => {
    expect(agentStateView({ ...base, state: 'working', paused: true })).toEqual({ text: '已暂停', color: 'purple' })
    expect(agentStateView({ ...base, state: 'waiting', waitingFor: 'question', paused: true })).toEqual({
      text: '已暂停',
      color: 'purple',
    })
  })

  it('未知状态原样透出（便于排查），不吞掉', () => {
    expect(agentStateView({ ...base, state: 'sleeping' })).toEqual({ text: 'sleeping', color: 'default' })
  })
})
