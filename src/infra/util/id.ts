/** 轻量 id / 时间工具（无 IO）。 */

/** 取当前 UTC 时间 ISO-8601 字符串。 */
export function nowIso(): string {
  return new Date().toISOString()
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 生成随机后缀（默认 8 位，小写字母+数字）。 */
export function randomSuffix(length = 8): string {
  let out = ''
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

/** 带前缀 id：prefix + 时间基36 + 随机后缀，如 p_1a2b3c… */
export function genId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomSuffix(6)}`
}

/** 校验项目/实例等 id 前缀是否来自允许集合（防伪造目录名）。 */
export function isAllowedIdPrefix(p: string, prefixes: readonly string[]): boolean {
  return prefixes.includes(p)
}
