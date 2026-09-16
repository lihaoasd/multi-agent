import { describe, expect, it } from 'vitest'
import { buildAppConfig, DEFAULT_APP_CONFIG, parseEnvText } from '../../../src/shared/config'

describe('shared/config · parseEnvText', () => {
  it('忽略注释与空行，解析键值并去掉成对引号', () => {
    const parsed = parseEnvText(
      [
        '# 注释',
        '',
        'SERVER__PORT=3000',
        'SERVER__HOST="127.0.0.1"',
        "DATA_DIR='data'",
        'export SANDBOX__NETWORK=offline',
        'EMPTY=',
        'NO_SEPARATOR',
      ].join('\r\n'),
    )
    expect(parsed).toEqual({
      SERVER__PORT: '3000',
      SERVER__HOST: '127.0.0.1',
      DATA_DIR: 'data',
      SANDBOX__NETWORK: 'offline',
      EMPTY: '',
    })
  })

  it('值中保留等号与空格（只按首个 = 切分）', () => {
    const parsed = parseEnvText('MODELS__EXPR=a=b=c')
    expect(parsed['MODELS__EXPR']).toBe('a=b=c')
  })
})

describe('shared/config · buildAppConfig', () => {
  it('无环境变量时取内置默认值', () => {
    expect(buildAppConfig({})).toEqual(DEFAULT_APP_CONFIG)
  })

  it('合法值覆盖默认值', () => {
    const config = buildAppConfig({
      SERVER__HOST: '0.0.0.0',
      SERVER__PORT: '4321',
      DATA_DIR: 'runtime',
      ROLE_DIRS: '["roles","builtin/roles"]',
      MODELS__CONFIG_FILE: 'data/models.json',
      MODELS__IMPORT_FROM_ENV: 'false',
      MODELS__REQUEST_TIMEOUT_MS: '15000',
      MODELS__MAX_PROMPT_CHARS: '12000',
      APPROVAL__CODE_SUBMIT_APPROVAL: 'true',
      SANDBOX__NETWORK: 'offline',
      CONTEXT__SESSION__RAW_WINDOW: '10',
    })
    expect(config.server).toEqual({ host: '0.0.0.0', port: 4321 })
    expect(config.dataDir).toBe('runtime')
    expect(config.roleDirs).toEqual(['roles', 'builtin/roles'])
    expect(config.models).toEqual({
      configFile: 'data/models.json',
      importFromEnv: false,
      requestTimeoutMs: 15000,
      maxPromptChars: 12000,
    })
    expect(config.approval.codeSubmitApproval).toBe(true)
    expect(config.sandbox.network).toBe('offline')
    expect(config.context.session.rawWindow).toBe(10)
  })

  it('非法值回退默认（端口越界、非整数、坏 JSON、未知布尔、未知联网模式）', () => {
    const config = buildAppConfig({
      SERVER__PORT: '99999',
      MODELS__REQUEST_TIMEOUT_MS: '12.5',
      ROLE_DIRS: 'not-json',
      MODELS__IMPORT_FROM_ENV: 'maybe',
      SANDBOX__NETWORK: 'lan-only',
      CONTEXT__SESSION__RAW_WINDOW: '-3',
    })
    expect(config.server.port).toBe(DEFAULT_APP_CONFIG.server.port)
    expect(config.models.requestTimeoutMs).toBe(DEFAULT_APP_CONFIG.models.requestTimeoutMs)
    expect(config.roleDirs).toEqual(DEFAULT_APP_CONFIG.roleDirs)
    expect(config.models.importFromEnv).toBe(DEFAULT_APP_CONFIG.models.importFromEnv)
    expect(config.sandbox.network).toBe('online')
    expect(config.context.session.rawWindow).toBe(DEFAULT_APP_CONFIG.context.session.rawWindow)
  })

  it('空字符串视为未配置', () => {
    const config = buildAppConfig({ SERVER__HOST: '   ', DATA_DIR: '' })
    expect(config.server.host).toBe(DEFAULT_APP_CONFIG.server.host)
    expect(config.dataDir).toBe(DEFAULT_APP_CONFIG.dataDir)
  })
})
