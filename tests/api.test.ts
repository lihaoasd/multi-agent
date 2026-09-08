import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../src/server/app.js'
import { ProjectService } from '../src/application/project/project-service.js'
import { loadConfig } from '../src/shared/config.js'
import { makeTempDir } from './helpers.js'

let base: string
let workdir: string
let app: FastifyInstance

beforeEach(async () => {
  base = await makeTempDir('api-')
  workdir = join(base, 'workdir')
  await mkdir(workdir)
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  const projectService = new ProjectService(join(config.dataDir, 'projects'), {
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: true },
    approvalPolicy: { highRiskCommands: true },
  })
  app = await buildApp({ config, projectService })
})
afterEach(async () => {
  await app.close()
  await rm(base, { recursive: true, force: true })
})

describe('HTTP API（Fastify inject）', () => {
  it('GET /api/config 返回模型默认与策略', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models.default).toBe('mock')
    expect(body.approval.docSubmitApproval).toBe(true)
  })

  it('POST → GET 列表 → PATCH → DELETE 闭环', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'todo-app', workdir },
    })
    expect(created.statusCode).toBe(201)
    const project = created.json().project
    expect(project.id).toMatch(/^p_/)

    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.statusCode).toBe(200)
    expect(list.json().projects).toHaveLength(1)

    const detail = await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })
    expect(detail.json().project.name).toBe('todo-app')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { name: 'todo-app-v2', description: 'hi' },
    })
    expect(patched.json().project.name).toBe('todo-app-v2')

    const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })
    expect(removed.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(after.json().projects).toHaveLength(0)
  })

  it('POST 缺 workdir 返回统一错误体 ERR_VALIDATION', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'ERR_VALIDATION', message: 'name 与 workdir 为必填字符串' })
  })

  it('workdir 不存在 → ERR_VALIDATION', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x', workdir: join(base, 'no-such') },
    })
    expect(res.json().code).toBe('ERR_VALIDATION')
  })

  it('GET 不存在的项目 → 404 ERR_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/p_zzz' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('ERR_NOT_FOUND')
  })

  it('GET /api/fs/browse 浏览真实目录', async () => {
    await writeFile(join(workdir, 'readme.md'), '# hi')
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/browse?path=${encodeURIComponent(workdir)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries.map((e: { name: string }) => e.name)).toContain('readme.md')
  })

  it('未知路由 → 404（Fastify 默认）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
  })
})
