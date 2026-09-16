import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

interface TemplateBody {
  roleId: string
  name: string
  source: 'builtin' | 'user'
  editable: boolean
  enabled: boolean
  systemPrompt: string
  defaultModel: string | null
  defaultModelAvailable: boolean
  defaultLoop: { strategy: string; params: Record<string, unknown> }
}

describe('API · Agent 模板配置（FR-35 / 规则 29）', () => {
  let context: TestContext

  beforeAll(async () => {
    context = await createTestServer()
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('列出 8 个内置模板，默认模型留空（S10：Agent 默认不配置模型）', async () => {
    const response = await inject({ method: 'GET', url: '/api/agent-templates' })
    expect(response.statusCode).toBe(200)
    const templates = response.json<TemplateBody[]>()
    expect(templates).toHaveLength(8)
    expect(templates.map((item) => item.roleId).sort()).toEqual(
      ['architect', 'dev', 'ops', 'pm', 'product', 'qa', 'ui', 'ux'].sort(),
    )
    expect(templates.every((item) => item.source === 'builtin')).toBe(true)
    expect(templates.every((item) => item.editable === false)).toBe(true)
    const pm = templates.find((item) => item.roleId === 'pm')
    expect(pm?.defaultModel).toBeNull()
    expect(pm?.defaultModelAvailable).toBe(false)
    expect(pm?.defaultLoop.strategy).toBe('plan-execute')
  })

  it('按场景筛选', async () => {
    const scoped = await inject({ method: 'GET', url: '/api/agent-templates?scenario=software' })
    expect(scoped.json<TemplateBody[]>()).toHaveLength(8)
    const empty = await inject({ method: 'GET', url: '/api/agent-templates?scenario=general' })
    expect(empty.json<TemplateBody[]>()).toHaveLength(0)
  })

  it('内置模板不可原地修改（ERR_FORBIDDEN，提示复制新建）', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm',
      payload: { systemPrompt: '试图改内置' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string; message: string }>().message).toContain('基于内置复制新建')
  })

  it('基于内置复制新建 → 可编辑', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId: 'pm-x', copyFrom: 'pm', name: '项目经理（定制）' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json<TemplateBody>()
    expect(body.source).toBe('user')
    expect(body.editable).toBe(true)

    const conflict = await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId: 'pm-x', copyFrom: 'pm' },
    })
    expect(conflict.statusCode).toBe(409)

    const missing = await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId: 'ghost-x', copyFrom: 'ghost' },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('三项配置校验：空提示词 / 未知策略 / 参数越界 / 模型不存在 全部拒绝', async () => {
    const emptyPrompt = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: { systemPrompt: '   ' },
    })
    expect(emptyPrompt.statusCode).toBe(400)
    expect(emptyPrompt.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    const unknownStrategy = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: { defaultLoop: { strategy: 'telepathy', params: {} } },
    })
    expect(unknownStrategy.statusCode).toBe(400)

    const outOfRange = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: { defaultLoop: { strategy: 'direct', params: { maxIterations: 99 } } },
    })
    expect(outOfRange.statusCode).toBe(400)

    const badModel = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: { defaultModel: 'ghost-model' },
    })
    expect(badModel.statusCode).toBe(400)

    const nothing = await inject({ method: 'PATCH', url: '/api/agent-templates/pm-x', payload: {} })
    expect(nothing.statusCode).toBe(400)
  })

  it('合法提交生效并留下历史快照（规则 29）', async () => {
    const updated = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: {
        systemPrompt: '你是定制版项目经理。',
        defaultLoop: { strategy: 'direct', params: { maxIterations: 3 } },
      },
    })
    expect(updated.statusCode).toBe(200)
    const body = updated.json<TemplateBody>()
    expect(body.systemPrompt).toBe('你是定制版项目经理。')
    expect(body.defaultLoop).toEqual({ strategy: 'direct', params: { maxIterations: 3 } })

    const history = await inject({ method: 'GET', url: '/api/agent-templates/pm-x/history' })
    expect(history.statusCode).toBe(200)
    expect(history.json<string[]>().length).toBeGreaterThanOrEqual(2)

    const reloaded = await inject({ method: 'GET', url: '/api/agent-templates/pm-x' })
    expect(reloaded.json<TemplateBody>().systemPrompt).toBe('你是定制版项目经理。')

    // 内置模板不受用户模板影响
    const builtin = await inject({ method: 'GET', url: '/api/agent-templates/pm' })
    expect(builtin.json<TemplateBody>().systemPrompt).not.toBe('你是定制版项目经理。')
  })

  it('模板引用模型 → 停用该模型需 confirm，删除被引用模型被拒（规则 27/29）', async () => {
    // S10：出厂无任何供应商/模型，本用例显式配置一个真实 kind 的供应商 + 模型条目
    const provider = await inject({
      method: 'POST',
      url: '/api/model-providers',
      payload: {
        id: 'ref-provider',
        name: '引用供应商',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        credential: { mode: 'file', value: '' },
      },
    })
    expect(provider.statusCode).toBe(201)

    const model = await inject({
      method: 'POST',
      url: '/api/models',
      payload: { id: 'ref-model', providerId: 'ref-provider', model: 'ref-model', displayName: '被引用模型' },
    })
    expect(model.statusCode).toBe(201)

    const referenced = await inject({
      method: 'PATCH',
      url: '/api/agent-templates/pm-x',
      payload: { defaultModel: 'ref-model' },
    })
    expect(referenced.statusCode).toBe(200)
    expect(referenced.json<TemplateBody>().defaultModelAvailable).toBe(true)

    const disableWithoutConfirm = await inject({
      method: 'PATCH',
      url: '/api/models/ref-model',
      payload: { enabled: false },
    })
    expect(disableWithoutConfirm.statusCode).toBe(409)
    expect(disableWithoutConfirm.json<{ code: string }>().code).toBe('ERR_CONFLICT')
    expect(
      disableWithoutConfirm.json<{ detail: { referrers: Array<{ kind: string; id: string }> } }>().detail.referrers,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'template', id: 'pm-x' })]))

    const deleteBlocked = await inject({ method: 'DELETE', url: '/api/models/ref-model' })
    expect(deleteBlocked.statusCode).toBe(409)

    // 模板改为不引用（留空 = 未配置）后可删
    await inject({ method: 'PATCH', url: '/api/agent-templates/pm-x', payload: { defaultModel: null } })
    expect((await inject({ method: 'DELETE', url: '/api/models/ref-model' })).statusCode).toBe(200)
  })

  it('停用/启用模板（S11：内置模板也可停用，状态落数据目录并跨重启保持）与 WS 广播', async () => {
    // 内置模板：停用写 `data/agent-templates-state.json`（仓库 yaml 只读）
    const disabledBuiltin = await inject({ method: 'POST', url: '/api/agent-templates/pm/disable' })
    expect(disabledBuiltin.statusCode).toBe(200)
    expect(disabledBuiltin.json<TemplateBody & { enabled: boolean }>().enabled).toBe(false)

    const state = await context.deps.fileStore.readJson<{ disabledBuiltins: string[] }>(
      `${context.dataDir}/agent-templates-state.json`,
    )
    expect(state.ok && state.value.disabledBuiltins).toContain('pm')

    // 模拟重启：同一数据根的新容器仍然停用
    const revived = await createTestServer({ root: context.root, cleanupRoot: false })
    try {
      const templates = (await revived.app.inject({ method: 'GET', url: '/api/agent-templates' })).json<TemplateBody[]>()
      expect(templates.find((item) => item.roleId === 'pm')?.enabled).toBe(false)
    } finally {
      await revived.cleanup()
    }

    const reEnabled = await inject({ method: 'POST', url: '/api/agent-templates/pm/enable' })
    expect(reEnabled.statusCode).toBe(200)
    expect(reEnabled.json<TemplateBody & { enabled: boolean }>().enabled).toBe(true)

    const userDisabled = await inject({ method: 'POST', url: '/api/agent-templates/pm-x/disable' })
    expect(userDisabled.statusCode).toBe(200)
    expect(userDisabled.json<TemplateBody & { enabled: boolean }>().enabled).toBe(false)

    const enabled = await inject({ method: 'POST', url: '/api/agent-templates/pm-x/enable' })
    expect(enabled.json<TemplateBody & { enabled: boolean }>().enabled).toBe(true)

    expect(context.broadcaster.events().some((event) => event.type === 'agent-config.updated')).toBe(true)
  })

  it('审计文件记录了模板变更且不含提示词全文', async () => {
    const audit = await context.deps.fileStore.readText(`${context.dataDir}/config-audit.jsonl`)
    expect(audit.ok).toBe(true)
    if (!audit.ok) return
    const lines = audit.value.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const templateAudit = lines.filter((line) => line['scope'] === 'template')
    expect(templateAudit.length).toBeGreaterThan(0)
    expect(templateAudit.some((line) => JSON.stringify(line).includes('你是定制版项目经理'))).toBe(false)
  })
})
