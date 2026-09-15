import type { ErrorCode } from './errors'

/** 领域/应用层的统一错误体（跨层返回一律用 Result，不用异常表达业务失败） */
export interface AppError {
  readonly code: ErrorCode
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err(
  code: ErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): Result<never> {
  return detail === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, detail } }
}

export function isOk<T>(result: Result<T>): result is { readonly ok: true; readonly value: T } {
  return result.ok
}

export function isErr<T>(result: Result<T>): result is { readonly ok: false; readonly error: AppError } {
  return !result.ok
}

/** 失败时回退默认值；用于非关键路径，不用于掩盖错误 */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.value : fallback
}

/** 失败时抛出；仅在边界层（bootstrap/server）把 Result 转异常时使用 */
export function unwrapOrThrow<T>(result: Result<T>): T {
  if (result.ok) return result.value
  const { code, message, detail } = result.error
  throw new Error(detail === undefined ? `${code}: ${message}` : `${code}: ${message} ${JSON.stringify(detail)}`)
}

export function mapResult<T, U>(result: Result<T>, map: (value: T) => U): Result<U> {
  return result.ok ? ok(map(result.value)) : result
}
