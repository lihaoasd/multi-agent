import { describe, expect, it } from 'vitest'
import { missingBasePackages, normalizePackages } from '../../../src/domain/rules/tool-packages'
import { BASE_TOOL_PACKAGES } from '../../../src/shared/loop'

/**
 * S25：基础工具包「全员必装」。
 * 8 个基础包是**地板**——任何角色/实例的挂载清单都必须包含它们，缺了就补齐（读/写两侧统一归一）。
 */
describe('domain/rules/tool-packages · 基础包全员必装', () => {
  it('空清单 → 完整 8 个基础包（顺序稳定）', () => {
    expect(normalizePackages([])).toEqual([...BASE_TOOL_PACKAGES])
    expect(BASE_TOOL_PACKAGES).toHaveLength(8)
  })

  it('缺基础包时补齐，且基础包排在前、顺序不随输入变化', () => {
    expect(normalizePackages(['task', 'fs'])).toEqual([...BASE_TOOL_PACKAGES])
    // 输入顺序打乱也一样
    expect(normalizePackages(['interaction', 'approval', 'session'])).toEqual([...BASE_TOOL_PACKAGES])
  })

  it('模板额外声明的包保留在基础包之后（去重）', () => {
    expect(normalizePackages(['custom_kit', 'fs', 'custom_kit', 'another'])).toEqual([
      ...BASE_TOOL_PACKAGES,
      'custom_kit',
      'another',
    ])
  })

  it('已完整的清单保持不变（幂等）', () => {
    const full = normalizePackages([...BASE_TOOL_PACKAGES])
    expect(normalizePackages(full)).toEqual(full)
  })

  it('missingBasePackages：合规为空，缺包时点名', () => {
    expect(missingBasePackages([...BASE_TOOL_PACKAGES])).toEqual([])
    expect(missingBasePackages(['fs', 'cmd'])).toEqual([
      'memory',
      'session',
      'artifact',
      'approval',
      'task',
      'interaction',
    ])
    expect(missingBasePackages([])).toEqual([...BASE_TOOL_PACKAGES])
  })
})
