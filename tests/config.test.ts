import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/shared/config.js'

describe('loadConfig', () => {
  it('空文件返回默认值', () => {
    const cfg = loadConfig({}, 'C:/base')
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 3000 })
    expect(cfg.models.default).toBe('mock')
    expect(cfg.approval).toEqual({
      highRiskCommands: true,
      docSubmitApproval: true,
      codeSubmitApproval: false,
    })
    expect(cfg.context.session.rawWindow).toBe(60)
  })

  it('逐段覆盖并合并子段', () => {
    const cfg = loadConfig(
      {
        server: { port: 4000 },
        models: { default: 'deepseek-chat' },
        context: { session: { rawWindow: 30 } },
      },
      'C:/base',
    )
    expect(cfg.server.host).toBe('127.0.0.1') // 未覆盖保留
    expect(cfg.server.port).toBe(4000)
    expect(cfg.models.default).toBe('deepseek-chat')
    expect(cfg.models.providers).toEqual([])
    expect(cfg.context.session).toEqual({ rawWindow: 30, maxCharsPerMsg: 2000 })
    expect(cfg.context.global.maxEntries).toBe(12)
  })

  it('相对路径 dataDir 解析为绝对路径', () => {
    const cfg = loadConfig({ dataDir: 'data' }, 'C:/app')
    expect(cfg.dataDir).toBe(resolve('C:/app/data'))
  })

  it('绝对路径 dataDir 原样保留', () => {
    const cfg = loadConfig({ dataDir: 'D:/haness-data' }, 'C:/app')
    expect(cfg.dataDir).toBe('D:/haness-data')
  })

  it('providers 数组整体替换', () => {
    const cfg = loadConfig(
      {
        models: {
          providers: [{ id: 'mock', kind: 'mock' }],
        },
      },
      'C:/base',
    )
    expect(cfg.models.providers).toHaveLength(1)
  })
})
