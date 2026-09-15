import type { FastifyInstance, FastifyReply } from 'fastify'
import { HTTP_STATUS_BY_ERROR_CODE, type ErrorCode } from '../shared/errors'
import type { AppError, Result } from '../shared/result'

/**
 * REST 错误出口：统一体 `{ code, message, detail? }`（contract.md §1/§4）。
 * 业务层用 Result 表达失败；路由用 `replyFromResult` 映射；无法映射的异常统一 ERR_INTERNAL。
 */
export class HttpError extends Error {
  readonly code: ErrorCode
  readonly detail?: Readonly<Record<string, unknown>>

  constructor(code: ErrorCode, message: string, detail?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.detail = detail
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof HttpError) {
    return error.detail === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, detail: error.detail }
  }
  if (error instanceof Error) {
    const fastifyCode = (error as { code?: unknown }).code
    if (typeof fastifyCode === 'string' && fastifyCode.startsWith('FST_ERR_VALIDATION')) {
      return { code: 'ERR_VALIDATION', message: error.message }
    }
    if (typeof fastifyCode === 'string' && fastifyCode.startsWith('ERR_')) {
      return { code: fastifyCode as ErrorCode, message: error.message }
    }
    // 客户端请求错误（内容类型不支持、body 为空/过大、JSON 坏）→ 一律 4xx 语义，不能报成 500
    const status = (error as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { code: status === 404 ? 'ERR_NOT_FOUND' : 'ERR_VALIDATION', message: error.message }
    }
    return { code: 'ERR_INTERNAL', message: error.message }
  }
  return { code: 'ERR_INTERNAL', message: '未知错误' }
}

export function sendError(reply: FastifyReply, error: AppError): FastifyReply {
  const status = HTTP_STATUS_BY_ERROR_CODE[error.code] ?? 500
  return reply.code(status).send(error)
}

/** Result → HTTP：成功取 `okStatus`（默认 200），失败按错误码映射状态 */
export function replyFromResult<T>(reply: FastifyReply, result: Result<T>, okStatus = 200): FastifyReply {
  if (result.ok) return reply.code(okStatus).send(result.value)
  return sendError(reply, result.error)
}

export interface RegisterErrorHandlerOptions {
  /** 记录内部错误（5xx）的钩子 */
  readonly onInternalError?: (error: unknown, appError: AppError) => void
}

export function registerErrorHandler(app: FastifyInstance, options: RegisterErrorHandlerOptions = {}): void {
  app.setErrorHandler((error, _request, reply) => {
    const appError = toAppError(error)
    if (appError.code === 'ERR_INTERNAL') {
      options.onInternalError?.(error, appError)
    }
    void sendError(reply, appError)
  })
}

/**
 * 纯 API 模式的 404（未构建前端时使用）。
 * 注意：Fastify 每个 prefix 只允许一个 notFound handler；有前端静态资源时改由
 * `server/static.ts` 注册 SPA 回退版，二者不可同时调用。
 */
export function registerJsonNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void sendError(reply, {
      code: 'ERR_NOT_FOUND',
      message: `接口不存在：${request.method} ${request.url}`,
    })
  })
}
