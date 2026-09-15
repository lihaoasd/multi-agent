import type { FastifyInstance } from 'fastify'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../../../src/server/app'
import { DEFAULT_APP_CONFIG } from '../../../src/shared/config'
import { createRecordingLogger } from '../../helpers'

describe('server · 骨架（纯 API 模式：未构建前端）', () => {
  let app: FastifyInstance
  const logger = createRecordingLogger()

  beforeAll(async () => {
    app = await createServer({
      config: DEFAULT_APP_CONFIG,
      logger,
      // 静态资源端口返回 null：server 只提供 API
      staticAssets: { distDir: () => null },
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health 返回进程自检信息（不含密钥）', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)

    const body = response.json<Record<string, unknown>>()
    expect(body).toMatchObject({
      status: 'ok',
      name: 'agent-haness',
      version: '0.1.0',
      dataDir: DEFAULT_APP_CONFIG.dataDir,
      sandboxNetwork: 'online',
    })
    expect(typeof body['uptimeMs']).toBe('number')
    expect(JSON.stringify(body)).not.toMatch(/sk-|apiKey/i)
  })

  it('未知接口返回统一错误体 {code,message}', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/not-exist' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'ERR_NOT_FOUND' })
  })

  it('已构建前端时：未知非 API 路径回退 index.html，API 路径仍返回 JSON 404', async () => {
    const spa = await createServer({
      config: DEFAULT_APP_CONFIG,
      logger,
      staticAssets: { distDir: () => resolve(process.cwd(), 'web') },
    })
    try {
      const page = await spa.inject({ method: 'GET', url: '/some/deep/link' })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<div id="root">')

      const api = await spa.inject({ method: 'GET', url: '/api/not-exist' })
      expect(api.statusCode).toBe(404)
      expect(api.json()).toMatchObject({ code: 'ERR_NOT_FOUND' })

      const health = await spa.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json()).toMatchObject({ status: 'ok' })
    } finally {
      await spa.close()
    }
  })
})
