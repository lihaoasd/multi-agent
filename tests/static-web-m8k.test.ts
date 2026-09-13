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
    // 问题列表：逐题显示 + 左右滑块 + 一次提交 + 答完自动跳下一题
    expect(body).toContain('q-nav')
    expect(body).toContain('上一题')
    expect(body).toContain('下一题')
    expect(body).toContain('提交全部回答')
    expect(body).toContain('scheduleNext')
    const css = String((await ready().inject({ method: 'GET', url: '/style.css' })).body)
    expect(css).toContain('.q-nav')
    expect(css).toContain('.q-item')
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
    // 右栏只显示活跃任务 + 面板三列：规则在同源纯函数模块里，这里保证接线没断
    expect(body).toContain('task-board.js')
    expect(body).toContain('activeTasks')
    expect(body).toContain('groupBoardTasks')
    const mod = await ready().inject({ method: 'GET', url: '/task-board.js' })
    expect(mod.statusCode).toBe(200)
    expect(String(mod.body)).toContain('BOARD_COLUMNS')
  })

  it('角色详情：左栏「详情」入口 + 只读弹窗（提示词/loop/工具）接线没断', async () => {
    const index = await ready().inject({ method: 'GET', url: '/' })
    const html = String(index.body)
    expect(html).toContain('agent-modal')
    expect(html).toContain('agent-detail-body')
    expect(html).toContain('btn-agent-close')

    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    const body = String(js.body)
    expect(body).toContain('openAgentDetail')
    expect(body).toContain('renderAgentDetail')
    expect(body).toContain('/agents/')
    expect(body).toContain('AGENT_LOOP_ZH')
    // 完整系统提示词预览：懒加载入口 + 逐段渲染 + 来源徽标
    expect(body).toContain('loadFullSystemPrompt')
    expect(body).toContain('agent-full-prompt')
    expect(body).toContain('/system-prompt')

    const css = String((await ready().inject({ method: 'GET', url: '/style.css' })).body)
    expect(css).toContain('.agent-detail-box')
    expect(css).toContain('.tool-chip')
    expect(css).toContain('.full-prompt-sec')
    expect(css).toContain('.origin-platform')
  })

  it('项目记录页：顶栏入口 + 记录视图 + 卡片渲染与一键跳源', async () => {
    const index = await ready().inject({ method: 'GET', url: '/' })
    const html = String(index.body)
    expect(html).toContain('btn-records')
    expect(html).toContain('records-view')
    expect(html).toContain('records-list')
    // 返回入口：页头「← 返回工作台」
    expect(html).toContain('btn-records-back')

    const js = await ready().inject({ method: 'GET', url: '/app.js' })
    const body = String(js.body)
    expect(body).toContain('showRecordsView')
    expect(body).toContain('showWorkbenchView')
    expect(body).toContain('btn-records-back')
    expect(body).toContain('refreshRecords')
    expect(body).toContain('renderRecords')
    expect(body).toContain('/records')
    expect(body).toContain('openRecordSource')
    // 会议完成 → 记录页刷新；任务终态 → 记录页刷新
    expect(body).toContain('refreshRecordsIfOpen')
    const css = String((await ready().inject({ method: 'GET', url: '/style.css' })).body)
    expect(css).toContain('.record-card')
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
