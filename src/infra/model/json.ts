/** 供应商响应是外部输入：统一用这些窄化工具读取，避免 `any` 与运行期崩溃 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 按路径读取外部响应；**同时支持对象键与数组下标**（SSE 帧里两类嵌套都常见） */
export function get(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    const record = asRecord(current)
    if (record === undefined) return undefined
    current = record[key]
  }
  return current
}

/** 拼接供应商 URL：baseUrl 末尾斜杠与路径前导斜杠都规范化 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** 工具参数可能是流式拼接的 JSON 片段，解析失败时原样返回字符串 */
export function parseToolArgs(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}
