import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RoleService } from '../../src/application/roles/role-service.js'
import { TeamService } from '../../src/application/team/team-service.js'
import { ProjectService } from '../../src/application/project/project-service.js'
import { ErrorCodes } from '../../src/shared/errors.js'
import { makeStoreForProjectsRoot, makeTempDir } from '../helpers.js'

const BUILTIN_DIR = resolve(process.cwd(), 'src/shared/roles')

let base: string
let customDir: string

beforeEach(async () => {
  base = await makeTempDir('roles-')
  customDir = join(base, 'custom-roles')
  await mkdir(customDir, { recursive: true })
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('RoleService', () => {
  it('加载 8 个内置模板且字段完整', async () => {
    const svc = new RoleService(BUILTIN_DIR, customDir)
    const roles = await svc.list()
    expect(roles.map((r) => r.roleId).sort()).toEqual(
      ['pm', 'product', 'architect', 'ux', 'ui', 'dev', 'qa', 'ops'].sort(),
    )
    for (const r of roles) {
      expect(r.name).toBeTruthy()
      expect(r.systemPrompt.length).toBeGreaterThan(20)
      expect(r.source).toBe('builtin')
      expect(Array.isArray(r.tools)).toBe(true)
      expect(r.defaultLoop.strategy).toBeTruthy()
    }
    // dev 具备执行工具
    const dev = await svc.get('dev')
    expect(dev.tools).toContain('cmd_run')
    expect(dev.tools).toContain('workdir_edit')
    // product 默认 reflective
    expect((await svc.get('product')).defaultLoop.strategy).toBe('reflective')
  })

  it('内置只读：改/删被拒', async () => {
    const svc = new RoleService(BUILTIN_DIR, customDir)
    await expect(svc.update('pm', { name: 'x' })).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    })
    await expect(svc.remove('pm')).rejects.toMatchObject({ code: ErrorCodes.CONFLICT })
    await expect(
      svc.create({
        roleId: 'pm',
        name: 'x',
        category: 'a',
        description: 'd',
        systemPrompt: 'p',
        defaultModel: 'mock',
        defaultLoop: { strategy: 'direct', params: {} },
        tools: [],
        artifactTypes: [],
        defaultApprovalRules: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT })
  })

  it('自定义模板 CRUD 落盘 data/roles', async () => {
    const svc = new RoleService(BUILTIN_DIR, customDir)
    const tpl = await svc.create({
      roleId: 'myops',
      name: '我的运维',
      category: 'operations',
      description: '自定义运维',
      systemPrompt: '你是我的运维',
      defaultModel: 'mock',
      defaultLoop: { strategy: 'direct', params: {} },
      tools: ['cmd_run'],
      artifactTypes: ['deploy'],
      defaultApprovalRules: {},
    })
    expect(tpl.source).toBe('custom')

    const updated = await svc.update('myops', { description: '改描述' })
    expect(updated.description).toBe('改描述')

    // 重新加载（模拟重启）仍可见
    const svc2 = new RoleService(BUILTIN_DIR, customDir)
    expect((await svc2.get('myops')).name).toBe('我的运维')

    await svc2.remove('myops')
    await expect(svc2.get('myops')).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND })
    // 文件确实删除
    await expect(access(join(customDir, 'myops.yaml'))).rejects.toThrow()
  })

  it('非法 roleId 拒绝', async () => {
    const svc = new RoleService(BUILTIN_DIR, customDir)
    await expect(
      svc.create({
        roleId: 'Bad Role!',
        name: 'x',
        category: 'a',
        description: 'd',
        systemPrompt: 'p',
        defaultModel: 'mock',
        defaultLoop: { strategy: 'direct', params: {} },
        tools: [],
        artifactTypes: [],
        defaultApprovalRules: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION })
  })
})

describe('TeamService + 实例骨架', () => {
  async function makeServices() {
    const projectsRoot = join(base, 'projects')
    const ps = new ProjectService(makeStoreForProjectsRoot(projectsRoot), {
      artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: true },
      approvalPolicy: { highRiskCommands: true },
    })
    const rs = new RoleService(BUILTIN_DIR, customDir)
    const ts = new TeamService(ps, rs)
    const workdir = join(base, 'wd')
    await mkdir(workdir)
    const project = await ps.create({ name: 'p', workdir })
    return { ps, ts, project }
  }

  it('实例快照模板默认值且结构符合 project.json schema', async () => {
    const { ts, project } = await makeServices()
    const m = await ts.add(project.id, { roleTemplateId: 'architect', displayName: '架构A' })
    expect(m.instanceId).toBe('architect_1')
    expect(m.displayName).toBe('架构A')
    expect(m.prompt).toContain('架构师') // 快照模板 systemPrompt
    expect(m.model).toBe('mock')
    expect(m.loop.strategy).toBe('reflective')
    expect(m.enabled).toBe(true)
  })

  it('add 建 workspaces/<iid>/ 与 sessions/u_<iid>.meta.json', async () => {
    const { ts, project } = await makeServices()
    await ts.add(project.id, { roleTemplateId: 'dev' })
    const runtime = join(base, 'projects', project.id)
    await expect(access(join(runtime, 'workspaces', 'dev_1'))).resolves.toBeUndefined()
    const metaFile = join(runtime, 'sessions', 'u_dev_1.meta.json')
    const meta = JSON.parse(await readFile(metaFile, 'utf8'))
    expect(meta.id).toBe('u_dev_1')
    expect(meta.type).toBe('user')
    expect(meta.state).toBe('active')
    expect(meta.participants.agents).toEqual(['dev_1'])
  })

  it('同模板重复实例 → ERR_CONFLICT', async () => {
    const { ts, project } = await makeServices()
    await ts.add(project.id, { roleTemplateId: 'pm' })
    await expect(ts.add(project.id, { roleTemplateId: 'pm' })).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    })
  })

  it('禁用保留数据、可重新启用', async () => {
    const { ps, ts, project } = await makeServices()
    await ts.add(project.id, { roleTemplateId: 'qa' })
    await ts.disable(project.id, 'qa_1')
    let m = await ts.get(project.id, 'qa_1')
    expect(m.enabled).toBe(false)
    await ts.enable(project.id, 'qa_1')
    m = await ts.get(project.id, 'qa_1')
    expect(m.enabled).toBe(true)
    // project.json 依然只有 1 个实例（未物理删）
    const proj = await ps.get(project.id)
    expect(proj.team).toHaveLength(1)
  })

  it('创建时的模板覆盖项生效', async () => {
    const { ts, project } = await makeServices()
    const m = await ts.add(project.id, {
      roleTemplateId: 'dev',
      model: 'deepseek-chat',
      loop: { strategy: 'direct' },
      tools: ['fs_read_file'],
    })
    expect(m.model).toBe('deepseek-chat')
    expect(m.loop.strategy).toBe('direct')
    expect(m.tools).toEqual(['fs_read_file'])
  })
})
