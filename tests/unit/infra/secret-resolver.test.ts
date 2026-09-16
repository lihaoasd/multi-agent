import { describe, expect, it } from 'vitest'
import { createSecretResolver } from '../../../src/infra/config/secret-resolver'

describe('infra/secret-resolver（规则 28：凭证解析边界）', () => {
  const env = { DEEPSEEK_API_KEY: 'sk-from-env-file' }

  it('file 模式：有值返回值，空值返回 null（ollama 不需要密钥）', () => {
    const resolver = createSecretResolver(env)
    expect(resolver.resolve({ mode: 'file', value: 'sk-inline' })).toEqual({ ok: true, value: 'sk-inline' })
    expect(resolver.resolve({ mode: 'file', value: '' })).toEqual({ ok: true, value: null })
  })

  it('env 模式：从传入的环境映射取值（覆盖 .env 文件场景，而非仅 process.env）', () => {
    const resolver = createSecretResolver(env)
    expect(resolver.resolve({ mode: 'env', envName: 'DEEPSEEK_API_KEY' })).toEqual({
      ok: true,
      value: 'sk-from-env-file',
    })
    expect(resolver.has({ mode: 'env', envName: 'DEEPSEEK_API_KEY' })).toBe(true)
  })

  it('env 模式：变量不存在即 ERR_VALIDATION（保存时就失败，不拖到调用期）', () => {
    const resolver = createSecretResolver(env)
    const missing = resolver.resolve({ mode: 'env', envName: 'NOT_SET' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ERR_VALIDATION')
    expect(resolver.has({ mode: 'env', envName: 'NOT_SET' })).toBe(false)
  })

  it('env 模式：空白值视为未设置', () => {
    const resolver = createSecretResolver({ BLANK: '   ' })
    expect(resolver.has({ mode: 'env', envName: 'BLANK' })).toBe(false)
  })
})
