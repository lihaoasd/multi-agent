import type { IdGenerator } from '../../ports/id'

export interface IdGeneratorOptions {
  /** 时间来源（默认 Date.now），测试可注入固定值 */
  readonly now?: () => number
  /** 随机源（默认 Math.random），测试可注入确定性序列 */
  readonly random?: () => number
}

const SUFFIX_LENGTH = 5
const SUFFIX_SPACE = 36 ** SUFFIX_LENGTH

/**
 * 确定性可注入的 id 生成器。
 * 注意：id 仅要求**项目/会话内唯一**，不承担排序语义（排序一律用 seq/ts）。
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  return {
    next(prefix: string): string {
      const stamp = Math.floor(now()).toString(36)
      const value = Math.floor(random() * SUFFIX_SPACE)
      const suffix = value.toString(36).padStart(SUFFIX_LENGTH, '0')
      return `${prefix}_${stamp}${suffix}`
    },
  }
}
