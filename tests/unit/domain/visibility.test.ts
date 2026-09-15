import { describe, expect, it } from 'vitest'
import {
  canReadMemory,
  canReadSession,
  filterVisibleMemories,
  visibilityFor,
} from '../../../src/domain/rules/visibility'
import type { MemoryEntry } from '../../../src/ports/memory'

function entry(scope: 'global' | 'agent', instanceId: string | null): MemoryEntry {
  return {
    id: `mem_${scope}_${instanceId ?? 'x'}`,
    ts: '2026-09-15T00:00:00.000Z',
    scope,
    instanceId,
    type: 'fact',
    content: '内容',
    source: { sessionId: 'u_dev_1', seq: 1 },
    tags: [],
    refs: [],
    state: 'active',
    supersededBy: null,
  }
}

/** 规则 7 / D18-②：检索与读取共用同一可见性判定 */
describe('domain/rules/visibility · 可见性（D18-②）', () => {
  it('用户（老板）不受限：所有会话与记忆可见', () => {
    const scope = visibilityFor({ kind: 'user' })
    expect(scope.sessionIds).toBeNull()
    expect(scope.instanceIds).toBeNull()
    expect(canReadSession({ kind: 'user' }, 'u_qa_1')).toBe(true)
    expect(canReadMemory({ kind: 'user' }, entry('agent', 'qa_1'))).toBe(true)
  })

  it('Agent 只可见本人会话', () => {
    const viewer = { kind: 'agent', instanceId: 'dev_1' } as const
    expect(canReadSession(viewer, 'u_dev_1')).toBe(true)
    expect(canReadSession(viewer, 'u_qa_1')).toBe(false)
  })

  it('Agent 可见全局记忆与本人角色记忆，不可见他角色记忆', () => {
    const viewer = { kind: 'agent', instanceId: 'dev_1' } as const
    expect(canReadMemory(viewer, entry('global', null))).toBe(true)
    expect(canReadMemory(viewer, entry('agent', 'dev_1'))).toBe(true)
    expect(canReadMemory(viewer, entry('agent', 'qa_1'))).toBe(false)
  })

  it('filterVisibleMemories 按同一规则过滤列表', () => {
    const viewer = { kind: 'agent', instanceId: 'dev_1' } as const
    const visible = filterVisibleMemories(viewer, [
      entry('global', null),
      entry('agent', 'dev_1'),
      entry('agent', 'qa_1'),
    ])
    expect(visible.map((item) => item.id)).toEqual(['mem_global_x', 'mem_agent_dev_1'])
  })
})
