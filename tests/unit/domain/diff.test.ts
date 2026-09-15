import { describe, expect, it } from 'vitest'
import { diffLines, diffSummary, unifiedDiff } from '../../../src/domain/rules/diff'

/** 变更审计与版本补丁的行级 diff（规则 4/10 的内容依据） */
describe('domain/rules/diff', () => {
  it('新增文件：全部行计 add，无 del', () => {
    expect(diffSummary(null, 'a\nb\nc')).toEqual({ add: 3, del: 0 })
  })

  it('删除文件：全部行计 del', () => {
    expect(diffSummary('a\nb', null)).toEqual({ add: 0, del: 2 })
  })

  it('修改文件：只统计真正变化的行（相同行算 context）', () => {
    const before = 'line1\nline2\nline3'
    const after = 'line1\nline2-changed\nline3\nline4'
    expect(diffSummary(before, after)).toEqual({ add: 2, del: 1 })
    const lines = diffLines(before, after)
    expect(lines.lines.filter((line) => line.kind === 'del').map((line) => line.text)).toEqual(['line2'])
  })

  it('CRLF 与末尾换行不影响行集合', () => {
    expect(diffSummary('a\r\nb\r\n', 'a\nb\n')).toEqual({ add: 0, del: 0 })
  })

  it('unifiedDiff 带文件头与 +/- 前缀（存为版本目录的 diff.patch）', () => {
    const patch = unifiedDiff({ relPath: 'src/login.ts', before: 'a', after: 'b' })
    expect(patch.split('\n')[0]).toBe('--- a/src/login.ts')
    expect(patch.split('\n')[1]).toBe('+++ b/src/login.ts')
    expect(patch).toContain('-a')
    expect(patch).toContain('+b')
  })

  it('新增文件时 before 侧为 /dev/null', () => {
    expect(unifiedDiff({ relPath: 'docs/prd.md', before: null, after: 'x' }).split('\n')[0]).toBe('--- /dev/null')
  })
})
