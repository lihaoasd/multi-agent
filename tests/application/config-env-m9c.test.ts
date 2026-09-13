/**
 * `.env` → 配置解析（M9C，2026-09-13）。
 *
 * 配置唯一来源改为 `.env`（config.yaml 已删除）：`configFromEnv(env)` 把扁平的环境变量
 * （约定：`__` 分层、数组用 JSON）解析成配置形状，交给 `loadConfig` 填默认值。
 * 这里直接喂显式 env 对象，不依赖真实 process.env，也不读盘。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { configFromEnv, loadConfig } from '../../src/shared/config.js'

describe('configFromEnv：.env → 配置', () => {
  it('空 env 返回空形状 → loadConfig 落到内置默认值', () => {
    const shape = configFromEnv({})
    expect(shape).toEqual({})
    const cfg = loadConfig(shape, 'C:/base')
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 3000 })
    expect(cfg.models.default).toBe('mock')
    expect(cfg.meeting).toEqual({ enabled: true, autoStart: true, autoClose: true })
    expect(cfg.task.assignByAgent).toBe(false)
    expect(cfg.context.session.rawWindow).toBe(60)
  })

  it('逐段解析：服务/路径/审批/沙箱/任务/会议/检索/上下文', () => {
    const cfg = loadConfig(
      configFromEnv({
        SERVER__HOST: '0.0.0.0',
        SERVER__PORT: '4100',
        DATA_DIR: 'var/data',
        ROLE_DIRS: '["src/shared/roles","custom/roles"]',
        MODELS__DEFAULT: 'deepseek-v4-flash',
        MODELS__PROVIDERS:
          '[{"id":"deepseek-v4-flash","kind":"openai-compatible","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY","model":"deepseek-v4-flash"}]',
        APPROVAL__HIGH_RISK_COMMANDS: 'false',
        APPROVAL__CODE_SUBMIT_APPROVAL: 'true',
        SANDBOX__NETWORK: 'offline',
        TASK__ASSIGN_BY_AGENT: 'true',
        MEETING__ENABLED: 'false',
        MEETING__AUTO_START: 'false',
        MEETING__AUTO_CLOSE: '0',
        SEARCH__ENGINE: 'vector',
        CONTEXT__SESSION__RAW_WINDOW: '30',
        CONTEXT__SESSION__MAX_CHARS_PER_MSG: '1500',
        CONTEXT__GLOBAL__MAX_ENTRIES: '5',
        CONTEXT__ROLE__MAX_ENTRIES: '6',
        CONTEXT__SEARCH__MAX_SNIPPETS: '2',
        CONTEXT__TOOL__RESULT_MAX_CHARS: '9000',
      }),
      'C:/base',
    )
    expect(cfg.server).toEqual({ host: '0.0.0.0', port: 4100 })
    expect(cfg.dataDir).toBe(resolve('C:/base/var/data'))
    expect(cfg.roleDirs).toEqual([resolve('C:/base/src/shared/roles'), resolve('C:/base/custom/roles')])
    expect(cfg.models.default).toBe('deepseek-v4-flash')
    expect(cfg.models.providers).toHaveLength(1)
    expect(cfg.models.providers[0]!.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(cfg.approval).toEqual({
      highRiskCommands: false,
      docSubmitApproval: true, // 未设置 → 默认
      codeSubmitApproval: true,
    })
    expect(cfg.sandbox.network).toBe('offline')
    expect(cfg.task.assignByAgent).toBe(true)
    expect(cfg.meeting).toEqual({ enabled: false, autoStart: false, autoClose: false })
    expect(cfg.search.engine).toBe('vector')
    expect(cfg.context.session).toEqual({ rawWindow: 30, maxCharsPerMsg: 1500 })
    expect(cfg.context.global.maxEntries).toBe(5)
    expect(cfg.context.role.maxEntries).toBe(6)
    expect(cfg.context.search.maxSnippets).toBe(2)
    expect(cfg.context.tool.resultMaxChars).toBe(9000)
  })

  it('只设置了部分键：其余保持默认（不会把整段打平）', () => {
    const cfg = loadConfig(configFromEnv({ SERVER__PORT: '3001', MEETING__ENABLED: 'false' }), 'C:/base')
    expect(cfg.server.host).toBe('127.0.0.1') // 未设置 → 默认
    expect(cfg.server.port).toBe(3001)
    expect(cfg.meeting.enabled).toBe(false)
    expect(cfg.meeting.autoStart).toBe(true) // 同段未设置的键保持默认
    expect(cfg.meeting.autoClose).toBe(true)
  })

  it('容错：非法 JSON / 非法数字 / 空串一律忽略并回退默认（不因笔误起不来）', () => {
    const cfg = loadConfig(
      configFromEnv({
        SERVER__PORT: 'not-a-number',
        MODELS__PROVIDERS: '{不是合法 JSON',
        ROLE_DIRS: '',
        SANDBOX__NETWORK: 'whatever',
        MEETING__ENABLED: 'maybe',
        SEARCH__ENGINE: 'fuzzy',
        CONTEXT__SESSION__RAW_WINDOW: 'abc',
      }),
      'C:/base',
    )
    expect(cfg.server.port).toBe(3000) // 默认
    expect(cfg.models.providers).toEqual([]) // 默认
    expect(cfg.roleDirs).toEqual([resolve('C:/base/src/shared/roles'), resolve('C:/base/data/roles')])
    expect(cfg.sandbox.network).toBe('online') // 非 online/offline → 默认
    expect(cfg.meeting.enabled).toBe(true) // 非布尔 → 默认
    expect(cfg.search.engine).toBe('keyword')
    expect(cfg.context.session.rawWindow).toBe(60)
  })

  it('布尔写法兼容 true/1/yes/on 与 false/0/no/off', () => {
    const yes = configFromEnv({ MEETING__ENABLED: 'YES', TASK__ASSIGN_BY_AGENT: 'on' })
    const no = configFromEnv({ MEETING__ENABLED: 'off', TASK__ASSIGN_BY_AGENT: '0' })
    expect(loadConfig(yes, 'C:/b').meeting.enabled).toBe(true)
    expect(loadConfig(yes, 'C:/b').task.assignByAgent).toBe(true)
    expect(loadConfig(no, 'C:/b').meeting.enabled).toBe(false)
    expect(loadConfig(no, 'C:/b').task.assignByAgent).toBe(false)
  })
})
