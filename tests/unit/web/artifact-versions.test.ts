import { describe, expect, it } from 'vitest'
import type { ArtifactRecord } from '../../../web/src/api/work'
import {
  actionText,
  conflictFiles,
  restorePlan,
  rollbackConfirmText,
  rollbackModeText,
  rollbackTone,
  versionRows,
} from '../../../web/src/lib/artifact-versions'

function record(overrides: Partial<ArtifactRecord> & { version: number }): ArtifactRecord {
  return {
    id: 'a_1',
    type: 'doc',
    title: 'PRD',
    summary: '',
    submitter: 'dev_1',
    state: 'approved',
    files: [],
    diffSummary: { add: 1, del: 0 },
    prevVersion: null,
    taskId: null,
    revertedTo: null,
    revertMode: null,
    ts: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }
}

describe('web/lib/artifact-versions · 版本历史展示（S54/D58）', () => {
  it('升序入、降序出；最新一版标 isCurrent', () => {
    const rows = versionRows([record({ version: 1 }), record({ version: 2 }), record({ version: 3 })])
    expect(rows.map((row) => row.version)).toEqual([3, 2, 1])
    expect(rows.map((row) => row.isCurrent)).toEqual([true, false, false])
  })

  it('状态文案区分「退回」与「撤销」，旧数据缺 revertMode 视为撤销', () => {
    expect(rollbackModeText(record({ version: 1, state: 'approved' }))).toBe('已登记')
    expect(rollbackModeText(record({ version: 2, state: 'reverted', revertedTo: 1, revertMode: 'restore' }))).toBe('已退回 v1')
    expect(rollbackModeText(record({ version: 3, state: 'reverted', revertedTo: 2, revertMode: 'undo' }))).toBe('已撤销 v2')
    // 旧数据（S54 之前只有 undo 一种）
    expect(rollbackModeText(record({ version: 4, state: 'reverted', revertedTo: 1 }))).toBe('已撤销 v1')
    expect(rollbackTone(record({ version: 1, state: 'approved' }))).toBe('green')
    expect(rollbackTone(record({ version: 2, state: 'reverted' }))).toBe('orange')
  })

  it('文件条目带动作文案', () => {
    expect(actionText('add')).toBe('新增')
    expect(actionText('modify')).toBe('修改')
    expect(actionText('delete')).toBe('删除')
    const rows = versionRows([
      record({
        version: 2,
        files: [{ relPath: 'docs/ux.md', action: 'add', hash: 'h' }],
      }),
    ])
    expect(rows[0]?.files).toEqual([{ relPath: 'docs/ux.md', action: 'add', actionText: '新增' }])
  })
})

describe('web/lib/artifact-versions · 退回预览（与服务端 restore 同源）', () => {
  const versions = [
    record({ version: 1, files: [{ relPath: 'docs/prd.md', action: 'add', hash: 'h1' }] }),
    record({ version: 2, files: [{ relPath: 'docs/prd.md', action: 'modify', hash: 'h2' }] }),
    record({ version: 3, files: [{ relPath: 'docs/ux.md', action: 'add', hash: 'h3' }] }),
  ]

  it('退回 v1：改过的文件写回；之后新增的文件删除', () => {
    const plan = restorePlan({ target: 1, versions })
    expect(plan.writes).toEqual(['docs/prd.md'])
    expect(plan.deletes).toEqual(['docs/ux.md'])
  })

  it('每个文件按"目标版本之后最早改它的那一版"定性（首次命中优先）', () => {
    const multi = [
      ...versions,
      // v4 又改了 prd —— 不能改变"最早是 v2 改的"这个结论
      record({ version: 4, files: [{ relPath: 'docs/prd.md', action: 'modify', hash: 'h4' }] }),
    ]
    const plan = restorePlan({ target: 1, versions: multi })
    expect(plan.writes).toEqual(['docs/prd.md'])
    expect(plan.deletes).toEqual(['docs/ux.md'])
  })

  it('退回 v2：只涉及 v2 之后的版本；退回最新版没有任何改动', () => {
    expect(restorePlan({ target: 2, versions })).toEqual({ writes: [], deletes: ['docs/ux.md'] })
    expect(restorePlan({ target: 3, versions })).toEqual({ writes: [], deletes: [] })
  })

  it('确认文案把"会发生什么 + 新版本号 + 历史不删"写清楚', () => {
    const plan = restorePlan({ target: 1, versions })
    const text = rollbackConfirmText({ target: 1, nextVersion: 4, plan })
    expect(text).toContain('写回 1 个文件')
    expect(text).toContain('删除 1 个新增文件')
    expect(text).toContain('v1 的内容')
    expect(text).toContain('新版本 v4')
    expect(text).toContain('历史版本不会被删除')
    expect(rollbackConfirmText({ target: 1, nextVersion: 2, plan: { writes: [], deletes: [] } })).toContain('没有文件需要改动')
  })

  it('冲突文件清单来自 detail.conflicted', () => {
    expect(conflictFiles({ conflicted: ['docs/prd.md', 'docs/ux.md'] })).toEqual(['docs/prd.md', 'docs/ux.md'])
    expect(conflictFiles({ conflicted: [1, 'docs/prd.md'] })).toEqual(['docs/prd.md'])
    expect(conflictFiles({ conflicted: 'docs/prd.md' })).toEqual([])
    expect(conflictFiles(undefined)).toEqual([])
  })
})
