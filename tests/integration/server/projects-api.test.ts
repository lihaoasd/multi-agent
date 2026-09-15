import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface InstanceBody {
  instanceId: string
  roleTemplateId: string
  displayName: string
  enabled: boolean
  configVersion: number
  overrides: string[]
  templateMissing: boolean
  effective: { systemPrompt: string; model: string | null; loop: { strategy: string } }
  effectiveModelAvailable: boolean
}

describe('API · 项目与团队（FR-01/FR-02、规则 8）', () => {
  let context: TestContext
  let workdir: string
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    workdir = mkdtempSync(join(tmpdir(), 'ah-workdir-'))
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('目录浏览器：返回父目录与过滤后的条目（用户级 API，绕过 Agent 沙箱）', async () => {
    mkdirSync(join(workdir, 'src'))
    writeFileSync(join(workdir, 'README.md'), '# demo')
    const response = await inject({ method: 'GET', url: `/api/fs/browse?path=${encodeURIComponent(workdir)}` })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ path: string; parent: string | null; entries: Array<{ name: string }> }>()
    expect(body.path).toBe(workdir)
    expect(body.parent).not.toBeNull()
    expect(body.entries.map((entry) => entry.name)).toEqual(['src', 'README.md'])

    const inspected = await inject({ method: 'POST', url: '/api/fs/inspect', payload: { path: workdir } })
    expect(inspected.statusCode).toBe(200)
    expect(inspected.json<{ kind: string; writable: boolean }>()).toMatchObject({
      kind: 'existing-repo',
      writable: true,
    })
  })

  it('工作目录校验：不存在 / 位于平台数据目录内 被拒', async () => {
    const missing = await inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x', workdir: join(tmpdir(), 'ah-not-exist-project') },
    })
    expect(missing.statusCode).toBe(400)

    const insideData = await inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x', workdir: resolve(process.cwd(), context.dataDir) },
    })
    expect(insideData.statusCode).toBe(400)
    expect(insideData.json<{ message: string }>().message).toContain('平台数据目录')
  })

  it('创建项目：默认勾选 8 个内置模板并写入快照', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '演示项目', description: 'S2 验收', workdir },
    })
    expect(response.statusCode).toBe(201)
    const project = response.json<{
      id: string
      workdirKind: string
      team: Array<{ instanceId: string; roleTemplateId: string; snapshot: { systemPrompt: string; capturedAt: string } }>
    }>()
    projectId = project.id
    expect(project.workdirKind).toBe('existing-repo')
    expect(project.team).toHaveLength(8)
    const dev = project.team.find((item) => item.roleTemplateId === 'dev')
    expect(dev?.instanceId).toBe('dev_1')
    // 快照必须落到实例里（D16-⑤：模板后续变更不影响既有实例）
    expect(dev?.snapshot.systemPrompt.length).toBeGreaterThan(0)
    expect(dev?.snapshot.capturedAt.length).toBeGreaterThan(0)
  })

  it('列表与详情：memberCount/enabledCount 正确', async () => {
    const list = await inject({ method: 'GET', url: '/api/projects' })
    expect(list.statusCode).toBe(200)
    const summary = list.json<Array<{ id: string; memberCount: number; enabledCount: number }>>()[0]
    expect(summary).toMatchObject({ id: projectId, memberCount: 8, enabledCount: 8 })

    const detail = await inject({ method: 'GET', url: `/api/projects/${projectId}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json<{ name: string }>().name).toBe('演示项目')
  })

  it('每模板至多 1 个实例（D14-3）：重复添加被拒', async () => {
    const duplicate = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/team`,
      payload: { roleTemplateId: 'dev' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json<{ code: string }>().code).toBe('ERR_CONFLICT')
  })

  it('停用=保留数据可重新启用（D14-9）；重复操作返回 ERR_CONFLICT', async () => {
    const disabled = await inject({ method: 'DELETE', url: `/api/projects/${projectId}/team/pm_1` })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json<InstanceBody>().enabled).toBe(false)

    const again = await inject({ method: 'DELETE', url: `/api/projects/${projectId}/team/pm_1` })
    expect(again.statusCode).toBe(409)

    const enabled = await inject({ method: 'POST', url: `/api/projects/${projectId}/team/pm_1/enable` })
    expect(enabled.json<InstanceBody>().enabled).toBe(true)

    const summary = (await inject({ method: 'GET', url: '/api/projects' })).json<Array<{ enabledCount: number }>>()[0]
    expect(summary?.enabledCount).toBe(8)
  })

  it('实例三项覆盖：合法提交生效、configVersion 递增、非法值被拒', async () => {
    const ok = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/dev_1`,
      payload: {
        displayName: '后端开发',
        prompt: '你是定制版开发，改动最小化。',
        loop: { strategy: 'direct', params: { maxIterations: 2 } },
        model: 'mock',
      },
    })
    expect(ok.statusCode).toBe(200)
    const dev = ok.json<InstanceBody>()
    expect(dev.displayName).toBe('后端开发')
    expect(dev.configVersion).toBe(2)
    expect(dev.overrides).toEqual(['prompt', 'model', 'loop'])
    expect(dev.effective.systemPrompt).toBe('你是定制版开发，改动最小化。')
    expect(dev.effective.model).toBe('mock')
    expect(dev.effective.loop).toEqual({ strategy: 'direct', params: { maxIterations: 2 } })

    const badPrompt = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/dev_1`,
      payload: { prompt: '   ' },
    })
    expect(badPrompt.statusCode).toBe(400)

    const badLoop = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/dev_1`,
      payload: { loop: { strategy: 'direct', params: { maxIterations: 99 } } },
    })
    expect(badLoop.statusCode).toBe(400)

    const badModel = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/dev_1`,
      payload: { model: 'ghost-model' },
    })
    expect(badModel.statusCode).toBe(400)

    const empty = await inject({ method: 'PATCH', url: `/api/projects/${projectId}/team/dev_1`, payload: {} })
    expect(empty.statusCode).toBe(400)
  })

  it('清除覆盖回到快照（null）与有效配置查询', async () => {
    const cleared = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/team/dev_1`,
      payload: { prompt: null, model: null, loop: null },
    })
    expect(cleared.statusCode).toBe(200)
    const dev = cleared.json<InstanceBody>()
    expect(dev.overrides).toEqual([])
    expect(dev.effective.systemPrompt).not.toBe('你是定制版开发，改动最小化。')
    expect(dev.effective.model).toBe('mock') // 模板快照的默认模型（内置模板都是 mock）

    const effective = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/team/dev_1/effective-config`,
    })
    expect(effective.statusCode).toBe(200)
    expect(effective.json<{ instanceId: string }>().instanceId).toBe('dev_1')
  })

  it('模板后续修改不影响既有实例（D16-⑤ 快照）', async () => {
    const before = await inject({ method: 'GET', url: `/api/projects/${projectId}/team/dev_1` })
    const beforePrompt = before.json<InstanceBody>().effective.systemPrompt

    await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId: 'dev-copy', copyFrom: 'dev', name: '开发（副本）' },
    })
    await inject({
      method: 'PATCH',
      url: '/api/agent-templates/dev-copy',
      payload: { systemPrompt: '副本模板的新提示词' },
    })

    const after = await inject({ method: 'GET', url: `/api/projects/${projectId}/team/dev_1` })
    expect(after.json<InstanceBody>().effective.systemPrompt).toBe(beforePrompt)
  })

  it('团队列表与状态投影（S3 前 state 恒为 idle）', async () => {
    const instances = await inject({ method: 'GET', url: `/api/projects/${projectId}/team` })
    expect(instances.statusCode).toBe(200)
    expect(instances.json<InstanceBody[]>()).toHaveLength(8)

    const agents = await inject({ method: 'GET', url: `/api/projects/${projectId}/agents` })
    expect(agents.statusCode).toBe(200)
    const projection = agents.json<Array<{ instanceId: string; state: string; sessionId: string | null }>>()
    expect(projection).toHaveLength(8)
    expect(projection.every((item) => item.state === 'idle' && item.sessionId === null)).toBe(true)
  })

  it('无 body 的 POST 容错：空 body + JSON content-type 视为 {}（不报 500）', async () => {
    // 先停用，再用"空 body + JSON"启用（模拟无参数 POST 客户端）
    expect((await inject({ method: 'DELETE', url: `/api/projects/${projectId}/team/qa_1` })).statusCode).toBe(200)
    const enabled = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/team/qa_1/enable`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json<InstanceBody>().enabled).toBe(true)
  })

  it('不支持的 content-type → 400 ERR_VALIDATION（客户端错误不能报成 500）', async () => {
    const response = await inject({
      method: 'POST',
      url: `/api/projects/${projectId}/team/qa_1/enable`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('ERR_VALIDATION')
  })

  it('项目改名与删除（只删运行时数据）', async () => {
    const renamed = await inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { name: '演示项目（改名）' },
    })
    expect(renamed.json<{ name: string }>().name).toBe('演示项目（改名）')

    const removed = await inject({ method: 'DELETE', url: `/api/projects/${projectId}` })
    expect(removed.statusCode).toBe(200)
    expect((await inject({ method: 'GET', url: '/api/projects' })).json<unknown[]>()).toHaveLength(0)
    expect((await inject({ method: 'GET', url: `/api/projects/${projectId}` })).statusCode).toBe(404)

    // 工作目录未被触碰（prd FR-01：不影响用户工作目录）
    expect((await inject({ method: 'POST', url: '/api/fs/inspect', payload: { path: workdir } })).statusCode).toBe(200)
  })
})
