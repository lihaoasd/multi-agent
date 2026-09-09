import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../src/server/app.js'
import { ProjectService } from '../src/application/project/project-service.js'
import { RoleService } from '../src/application/roles/role-service.js'
import { TeamService } from '../src/application/team/team-service.js'
import { loadConfig } from '../src/shared/config.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = resolve(process.cwd(), 'src/shared/roles')

let base: string
let workdir: string
let app: FastifyInstance

async function makeApp(dataRoot: string, roleCustomDir: string): Promise<FastifyInstance> {
  const config = loadConfig({ dataDir: dataRoot }, base)
  const projectService = new ProjectService(join(dataRoot, 'projects'), {
    artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: true },
    approvalPolicy: { highRiskCommands: true },
  })
  const roleService = new RoleService(BUILTIN_DIR, roleCustomDir)
  const teamService = new TeamService(projectService, roleService)
  return buildApp({ config, projectService, roleService, teamService })
}

beforeEach(async () => {
  base = await makeTempDir('api-')
  workdir = join(base, 'workdir')
  await mkdir(workdir)
  app = await makeApp(join(base, 'data'), join(base, 'roles'))
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

describe('角色库 REST', () => {
  it('GET /api/roles 返回全部内置模板', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/roles' })
    expect(res.statusCode).toBe(200)
    const ids = res.json().roles.map((r: { roleId: string }) => r.roleId)
    for (const id of ['pm', 'product', 'architect', 'ux', 'ui', 'dev', 'qa', 'ops']) {
      expect(ids).toContain(id)
    }
  })

  it('POST/PATCH/DELETE 自定义模板；内置只读', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/roles',
      payload: {
        roleId: 'mydev',
        name: '我的开发',
        category: 'engineering',
        description: '自定义',
        systemPrompt: '你是自定义开发',
        defaultModel: 'mock',
        defaultLoop: { strategy: 'direct', params: {} },
        tools: ['fs_read_file'],
        artifactTypes: ['doc'],
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().role.source).toBe('custom')

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/roles/mydev',
      payload: { description: '改' },
    })
    expect(patched.json().role.description).toBe('改')

    const del = await app.inject({ method: 'DELETE', url: '/api/roles/mydev' })
    expect(del.statusCode).toBe(204)

    // 内置只读
    const forbidden = await app.inject({
      method: 'PATCH',
      url: '/api/roles/pm',
      payload: { name: 'x' },
    })
    expect(forbidden.statusCode).toBe(409)
  })
})

describe('团队 REST（M1）', () => {
  async function createProject(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name, workdir },
    })
    return res.json().project.id
  }

  it('POST /team 创建实例并建 workspaces/sessions 骨架；同模板冲突', async () => {
    const pid = await createProject('team-app')
    const add = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/team`,
      payload: { roleTemplateId: 'dev' },
    })
    expect(add.statusCode).toBe(201)
    const member = add.json().member
    expect(member.instanceId).toBe('dev_1')
    expect(member.enabled).toBe(true)
    expect(member.prompt).toContain('高级开发') // 模板快照
    expect(member.tools).toContain('cmd_run')

    // 目录骨架
    const wsOk = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/team`,
    })
    expect(wsOk.json().team).toHaveLength(1)

    const dup = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/team`,
      payload: { roleTemplateId: 'dev' },
    })
    expect(dup.statusCode).toBe(409)

    const pm = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/team`,
      payload: { roleTemplateId: 'pm' },
    })
    expect(pm.statusCode).toBe(201)
    expect(pm.json().member.instanceId).toBe('pm_1')
  })

  it('向导一次性组队 + 失败回滚', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'wizard',
        workdir,
        team: [{ roleTemplateId: 'product' }, { roleTemplateId: 'dev' }],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().project.team.map((m: { instanceId: string }) => m.instanceId)).toEqual([
      'product_1',
      'dev_1',
    ])

    const bad = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'wizard-bad',
        workdir,
        team: [{ roleTemplateId: 'no-such-role' }],
      },
    })
    expect(bad.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json().projects.map((p: { name: string }) => p.name)).not.toContain('wizard-bad')
  })

  it('PATCH 改名/换模型；DELETE=停用 enabled=false 保留数据', async () => {
    const pid = await createProject('team-app2')
    await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/team`,
      payload: { roleTemplateId: 'qa', displayName: '质量官' },
    })
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/team/qa_1`,
      payload: { model: 'deepseek-chat', tools: ['fs_read_file'] },
    })
    const member = patched.json().member
    expect(member.displayName).toBe('质量官')
    expect(member.model).toBe('deepseek-chat')
    expect(member.tools).toEqual(['fs_read_file'])

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${pid}/team/qa_1` })
    expect(del.statusCode).toBe(204)
    const team = await app.inject({ method: 'GET', url: `/api/projects/${pid}/team` })
    expect(team.json().team[0].enabled).toBe(false)
    expect(team.json().team[0].displayName).toBe('质量官') // 数据保留
  })

  it('不存在的模板 404；不存在实例 404', async () => {
    const pid = await createProject('team-app3')
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/team`,
      payload: { roleTemplateId: 'zz' },
    })
    expect(bad.statusCode).toBe(404)
    const miss = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/team/nope_1`,
      payload: { displayName: 'x' },
    })
    expect(miss.statusCode).toBe(404)
  })
})
