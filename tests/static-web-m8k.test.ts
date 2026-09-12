import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { makeTempDir } from './helpers.js'
import { mkdir, rm } from 'node:fs/promises'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')
const WEB_DIR = join(process.cwd(), 'web')

let base: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('static-web-')
  await mkdir(join(base, 'workdir'), { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  const svc = composeServices(config, join(base, 'roles'))
  // 真实注册静态托管（index.ts 走的就是这条路径）——此前的 setHeaders 误用只在真实请求时炸
  app = await buildApp(svc, { webDir: WEB_DIR })
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

function ready(): FastifyInstance {
  if (!app) throw new Error('app not ready')
  return app
}

describe('前端静态托管（真实请求路径）', () => {
  it('GET / 返回 index.html，GET /app.js 返回脚本且带 no-cache（setHeaders 不炸）', async () => {
    const index = await ready().inject({ method: 'GET', url: '/' })
    expect(index.statusCode).toBe(200)
    expect(String(index.headers['content-type'])).toContain('text/html')
    expect(String(index.body)).toContain('Agent Haness')
    expect(index.headers['cache-control']).toBe('no-cache')

    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    expect(js.statusCode).toBe(200)
    expect(String(js.headers['content-type'])).toMatch(/javascript/)
    expect(js.headers['cache-control']).toBe('no-cache')
    expect(String(js.body)).toContain('connectWs')

    const css = await ready().inject({ method: 'GET', url: '/style.css' })
    expect(css.statusCode).toBe(200)
    expect(css.headers['cache-control']).toBe('no-cache')

    const md = await ready().inject({ method: 'GET', url: '/markdown.js' })
    expect(md.statusCode).toBe(200)
    expect(String(md.body)).toContain('renderMarkdown')
  })

  it('右侧栏不再有「产出物」栏（提交免审批，无回退入口）', async () => {
    const index = await ready().inject({ method: 'GET', url: '/' })
    expect(String(index.body)).not.toContain('产出物')
    expect(String(index.body)).not.toContain('artifact-list')

    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    const body = String(js.body)
    expect(body).not.toContain('renderArtifacts')
    expect(body).not.toContain('/artifacts')
    expect(body).not.toContain('/rollback')
  })

  it('提问卡片走 WS 推送（前端已接 question.asked/answered）', async () => {
    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    const body = String(js.body)
    expect(body).toContain('handleQuestionPush')
    expect(body).toContain('question.asked')
    expect(body).toContain('question.answered')
  })

  it('任务栏面板：右栏入口 + 弹窗 + WS task.updated 刷新', async () => {
    const index = await ready().inject({ method: 'GET', url: '/' })
    expect(String(index.body)).toContain('task-board')
    expect(String(index.body)).toContain('btn-task-board')
    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    const body = String(js.body)
    expect(body).toContain('renderTaskBoard')
    expect(body).toContain('handleTaskPush')
    expect(body).toContain('task.updated')
    expect(body).toContain('待领取')
  })

  it('未提供 webDir 时不注册静态托管（测试注入用），API 仍可用', async () => {
    const config = loadConfig({ dataDir: join(base, 'data2') }, base)
    config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
    const svc2 = composeServices(config, join(base, 'roles'))
    const app2 = await buildApp(svc2)
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/projects' })
      expect(res.statusCode).toBe(200)
      const root = await app2.inject({ method: 'GET', url: '/' })
      expect(root.statusCode).toBe(404)
    } finally {
      await app2.close()
    }
  })
})
