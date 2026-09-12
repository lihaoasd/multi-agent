/**
 * 统一错误码与错误类型。
 * 编码集合对齐 api/contract.md §4（REST 统一 ERR_*）；HTTP 状态码仅作粗分类。
 */

/** REST API 错误码全集（与 api/contract.md §4 表一致）。 */
export const ErrorCodes = {
  NOT_FOUND: 'ERR_NOT_FOUND',
  CONFLICT: 'ERR_CONFLICT',
  /** 归属限制：该文件/产出物属于别的角色（2026-09-12 署名与归属锁） */
  FORBIDDEN: 'ERR_FORBIDDEN',
  FORBIDDEN_PATH: 'ERR_FORBIDDEN_PATH',
  APPROVAL_REQUIRED: 'ERR_APPROVAL_REQUIRED',
  APPROVAL_REJECTED: 'ERR_APPROVAL_REJECTED',
  CMD_TIMEOUT: 'ERR_CMD_TIMEOUT',
  CMD_FORBIDDEN: 'ERR_CMD_FORBIDDEN',
  NET_OFFLINE: 'ERR_NET_OFFLINE',
  VALIDATION: 'ERR_VALIDATION',
  MODEL: 'ERR_MODEL',
  MEETING_BLOCKED: 'ERR_MEETING_BLOCKED',
  MEETING_FULL: 'ERR_MEETING_FULL',
  TOOL_REJECTED: 'ERR_TOOL_REJECTED',
  INTERNAL: 'ERR_INTERNAL',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** 错误码 → HTTP 状态粗分类（仅用于 REST 层，客户端以 code 为准）。 */
const HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.FORBIDDEN_PATH]: 403,
  [ErrorCodes.APPROVAL_REQUIRED]: 403,
  [ErrorCodes.APPROVAL_REJECTED]: 403,
  [ErrorCodes.CMD_TIMEOUT]: 408,
  [ErrorCodes.CMD_FORBIDDEN]: 403,
  [ErrorCodes.NET_OFFLINE]: 403,
  [ErrorCodes.VALIDATION]: 400,
  [ErrorCodes.MODEL]: 502,
  [ErrorCodes.MEETING_BLOCKED]: 409,
  [ErrorCodes.MEETING_FULL]: 409,
  [ErrorCodes.TOOL_REJECTED]: 403,
  [ErrorCodes.INTERNAL]: 500,
}

/** 领域/应用层可抛出的错误；HTTP 层统一映射为 { code, message }。 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code] ?? 500
    this.details = details
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}
