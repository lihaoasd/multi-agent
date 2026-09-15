import { err, ok, type Result } from '../../shared/result'

/** 路由层请求体读取：外部输入一律窄化，失败返回 ERR_VALIDATION（不抛异常） */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

export function requireString(record: Record<string, unknown>, key: string): Result<string> {
  const value = readString(record, key)
  return value === undefined || value.trim().length === 0
    ? err('ERR_VALIDATION', `缺少必填字段：${key}`, { field: key })
    : ok(value)
}

/** 凭证读取：`{ mode: 'file'|'env', value?/envName? }` */
export function readCredential(
  record: Record<string, unknown>,
): { mode: 'file'; value: string } | { mode: 'env'; envName: string } | undefined {
  const credential = record['credential']
  if (typeof credential !== 'object' || credential === null) return undefined
  const raw = credential as Record<string, unknown>
  if (raw['mode'] === 'env') {
    return { mode: 'env', envName: readString(raw, 'envName') ?? '' }
  }
  return { mode: 'file', value: readString(raw, 'value') ?? '' }
}

export function readLoopConfig(
  record: Record<string, unknown>,
  key = 'defaultLoop',
): { strategy: string; params: Record<string, unknown> } | undefined {
  const raw = record[key]
  if (typeof raw !== 'object' || raw === null) return undefined
  const loop = raw as Record<string, unknown>
  const strategy = readString(loop, 'strategy')
  if (strategy === undefined) return undefined
  const params = typeof loop['params'] === 'object' && loop['params'] !== null ? (loop['params'] as Record<string, unknown>) : {}
  return { strategy, params }
}
