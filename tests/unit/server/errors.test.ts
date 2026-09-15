import { describe, expect, it } from 'vitest'
import { HttpError, toAppError } from '../../../src/server/errors'

describe('server/errors · 统一错误映射（contract.md §4）', () => {
  it('HttpError 保留错误码与 detail', () => {
    const error = new HttpError('ERR_CONFLICT', '状态冲突', { state: 'working' })
    expect(toAppError(error)).toEqual({ code: 'ERR_CONFLICT', message: '状态冲突', detail: { state: 'working' } })
  })

  it('Fastify 校验错误 → ERR_VALIDATION', () => {
    const error = Object.assign(new Error('body must have required property name'), {
      code: 'FST_ERR_VALIDATION',
    })
    expect(toAppError(error).code).toBe('ERR_VALIDATION')
  })

  it('客户端请求错误（4xx statusCode）→ 4xx 语义，不能报成 500', () => {
    const unsupported = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 })
    expect(toAppError(unsupported)).toEqual({ code: 'ERR_VALIDATION', message: 'Unsupported Media Type' })

    const notFound = Object.assign(new Error('Route not found'), { statusCode: 404 })
    expect(toAppError(notFound).code).toBe('ERR_NOT_FOUND')

    const tooLarge = Object.assign(new Error('Request body is too large'), { statusCode: 413 })
    expect(toAppError(tooLarge).code).toBe('ERR_VALIDATION')
  })

  it('普通 Error / 非 Error → ERR_INTERNAL；5xx statusCode 仍是 ERR_INTERNAL', () => {
    expect(toAppError(new Error('炸了'))).toEqual({ code: 'ERR_INTERNAL', message: '炸了' })
    expect(toAppError('字符串')).toEqual({ code: 'ERR_INTERNAL', message: '未知错误' })
    expect(toAppError(Object.assign(new Error('上游炸'), { statusCode: 502 })).code).toBe('ERR_INTERNAL')
  })
})
