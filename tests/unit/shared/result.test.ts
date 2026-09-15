import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, mapResult, ok, unwrapOr, unwrapOrThrow } from '../../../src/shared/result'

describe('shared/result', () => {
  it('ok 返回成功分支并保留值', () => {
    const result = ok({ id: 'p_1' })
    expect(isOk(result)).toBe(true)
    expect(result).toEqual({ ok: true, value: { id: 'p_1' } })
  })

  it('err 返回失败分支，detail 省略时不落空字段', () => {
    const plain = err('ERR_NOT_FOUND', '项目不存在')
    expect(plain).toEqual({ ok: false, error: { code: 'ERR_NOT_FOUND', message: '项目不存在' } })

    const detailed = err('ERR_CONFLICT', '状态冲突', { state: 'working' })
    expect(isErr(detailed)).toBe(true)
    expect(detailed).toEqual({
      ok: false,
      error: { code: 'ERR_CONFLICT', message: '状态冲突', detail: { state: 'working' } },
    })
  })

  it('unwrapOr 在失败时回退默认值', () => {
    expect(unwrapOr(ok(3), 7)).toBe(3)
    expect(unwrapOr(err('ERR_VALIDATION', '非法'), 7)).toBe(7)
  })

  it('mapResult 只映射成功分支', () => {
    expect(mapResult(ok(2), (value) => value * 2)).toEqual({ ok: true, value: 4 })
    const failure = err('ERR_INTERNAL', '炸了')
    expect(mapResult(failure, (value: number) => value * 2)).toBe(failure)
  })

  it('unwrapOrThrow 在失败时抛出含错误码的信息', () => {
    expect(unwrapOrThrow(ok('v'))).toBe('v')
    expect(() => unwrapOrThrow(err('ERR_MODEL', '模型未配置', { modelId: 'm_1' }))).toThrow(
      /ERR_MODEL: 模型未配置/,
    )
  })
})
