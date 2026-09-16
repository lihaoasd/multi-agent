import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import { configureTestModel } from '../../helpers-model'

/**
 * S11（规则 32）：Agent 模板库**删除/停用**与**一键配置模型**
 * - 用户模板可删除（需 `confirm=true`，被项目实例引用 → `ERR_CONFLICT` + referrers）
 * - 内置模板只能停用（覆盖落 `data/agent-templates-state.json`，重启不复活）
 * - 批量设置默认模型（内置走数据目录覆盖、用户模板写自身 yaml）
 * - `GET /api/model-config/overview` 的"未配置模型 Agent"计数与一键设全局默认
 */

interface TemplateBody {
  roleId: string
  source: 'builtin' | 'user'
  enabled: boolean
  defaultModel: string | null
  defaultModelAvailable: boolean
  editable: boolean
  modelEditable: boolean
  deletable: boolean
}

interface OverviewBody {
  routing: { defaultModelId: string | null }
  unconfiguredAgents: { total: number; items: Array<{ projectId: string; instanceId: string }> }
}

describe('API · S11 模板删除/停用与一键配置模型（规则 32）', () => {
  let context: TestContext
  let workdir: string

  beforeAll(async () => {
    context = await createTestServer()
    workdir = mkdtempSync(join(tmpdir(), 'ah-s11-'))
    // 登记一个真实 kind 的模型（不设平台默认，便于验证"未配置"路径）
    await configureTestModel(context.deps, {
      providerId: 's11-provider',
      modelId: 's11-model',
      asPlatformDefault: false,
    })
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  const createCopy = async (roleId: string): Promise<void> => {
    const created = await inject({
      method: 'POST',
      url: '/api/agent-templates',
      payload: { roleId, copyFrom: 'dev', name: `${roleId} 副本` },
    })
    expect(created.statusCode).toBe(201)
  }

  it('内置模板只能停用：删除被拒（ERR_FORBIDDEN），停用状态落数据目录', async () => {
    const removed = await inject({ method: 'DELETE', url: '/api/agent-templates/pm?confirm=true' })
    expect(removed.statusCode).toBe(403)
    expect(removed.json<{ code: string }>().code).toBe('ERR_FORBIDDEN')

    const disabled = await inject({ method: 'POST', url: '/api/agent-templates/pm/disable' })
    expect(disabled.statusCode).toBe(200)
    const state = await context.deps.fileStore.readJson<{ disabledBuiltins: string[] }>(
      `${context.dataDir}/agent-templates-state.json`,
    )
    expect(state.ok && state.value.disabledBuiltins).toContain('pm')

    // 恢复启用，避免影响后续用例的"未配置"计数口径
    expect((await inject({ method: 'POST', url: '/api/agent-templates/pm/enable' })).statusCode).toBe(200)
  })

  it('用户模板：删除需二次确认；被项目实例引用时 409 并点名', async () => {
    await createCopy('s11-copy')

    const withoutConfirm = await inject({ method: 'DELETE', url: '/api/agent-templates/s11-copy' })
    expect(withoutConfirm.statusCode).toBe(400)
    expect(withoutConfirm.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    const created = await inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'S11 引用项目', workdir, members: [{ roleTemplateId: 's11-copy' }] },
    })
    expect(created.statusCode).toBe(201)
    const projectId = created.json<{ id: string }>().id

    const blocked = await inject({ method: 'DELETE', url: '/api/agent-templates/s11-copy?confirm=true' })
    expect(blocked.statusCode).toBe(409)
    const body = blocked.json<{ code: string; detail: { referrers: Array<{ projectId: string; instanceId: string }> } }>()
    expect(body.code).toBe('ERR_CONFLICT')
    expect(body.detail.referrers.map((item) => item.projectId)).toContain(projectId)

    // 解除引用后可删除（yaml 与历史目录一并清除）
    expect((await inject({ method: 'DELETE', url: `/api/projects/${projectId}` })).statusCode).toBe(200)
    expect((await inject({ method: 'DELETE', url: '/api/agent-templates/s11-copy?confirm=true' })).statusCode).toBe(200)
    expect(await context.deps.fileStore.exists(`${context.dataDir}/roles/s11-copy.yaml`)).toBe(false)
    expect((await inject({ method: 'GET', url: '/api/agent-templates/s11-copy' })).statusCode).toBe(404)
  })

  it('一键批量设置默认模型：内置写数据目录覆盖、用户模板写自身 yaml，且跨重启保持', async () => {
    await createCopy('s11-bulk')

    const bulk = await inject({
      method: 'POST',
      url: '/api/agent-templates/bulk-model',
      payload: { roleIds: ['pm', 's11-bulk'], defaultModel: 's11-model' },
    })
    expect(bulk.statusCode).toBe(200)
    const result = bulk.json<{ updated: string[]; skipped: unknown[] }>()
    expect(result.updated.sort()).toEqual(['pm', 's11-bulk'])
    expect(result.skipped).toEqual([])

    const pm = (await inject({ method: 'GET', url: '/api/agent-templates/pm' })).json<TemplateBody>()
    expect(pm).toMatchObject({ defaultModel: 's11-model', defaultModelAvailable: true, modelEditable: true, editable: false, deletable: false })

    const copy = (await inject({ method: 'GET', url: '/api/agent-templates/s11-bulk' })).json<TemplateBody>()
    expect(copy).toMatchObject({ defaultModel: 's11-model', editable: true, deletable: true })

    const state = await context.deps.fileStore.readJson<{ roleModelDefaults: Record<string, string | null> }>(
      `${context.dataDir}/agent-templates-state.json`,
    )
    expect(state.ok && state.value.roleModelDefaults['pm']).toBe('s11-model')

    // 内置模板：提示词/loop 仍只读，但"默认模型"单项可提交
    expect(
      (
        await inject({
          method: 'PATCH',
          url: '/api/agent-templates/pm',
          payload: { systemPrompt: '改内置提示词' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await inject({
          method: 'PATCH',
          url: '/api/agent-templates/pm',
          payload: { defaultModel: null },
        })
      ).statusCode,
    ).toBe(200)

    // 跨重启仍保持"用户模板写进 yaml"的默认模型
    const revived = await createTestServer({ root: context.root, cleanupRoot: false })
    try {
      const revivedCopy = (
        await revived.app.inject({ method: 'GET', url: '/api/agent-templates/s11-bulk' })
      ).json<TemplateBody>()
      expect(revivedCopy.defaultModel).toBe('s11-model')
    } finally {
      await revived.cleanup()
    }
  })

  it('批量接口校验：非法/停用模型 400、空选择 400、非法入参 400', async () => {
    const ghost = await inject({
      method: 'POST',
      url: '/api/agent-templates/bulk-model',
      payload: { roleIds: ['pm'], defaultModel: 'ghost-model' },
    })
    expect(ghost.statusCode).toBe(400)
    expect(ghost.json<{ code: string }>().code).toBe('ERR_VALIDATION')

    expect(
      (await inject({ method: 'POST', url: '/api/agent-templates/bulk-model', payload: { roleIds: [], defaultModel: null } }))
        .statusCode,
    ).toBe(400)

    expect(
      (
        await inject({
          method: 'POST',
          url: '/api/agent-templates/bulk-model',
          payload: { roleIds: 'pm', defaultModel: null },
        })
      ).statusCode,
    ).toBe(400)
  })

  it('未配置模型计数与一键设全局默认：计数随平台默认模型归零', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'S11 未配置项目', workdir },
    })
    const projectId = created.json<{ id: string }>().id

    const before = (await inject({ method: 'GET', url: '/api/model-config/overview' })).json<OverviewBody>()
    expect(before.routing.defaultModelId).toBeNull()
    expect(before.unconfiguredAgents.total).toBe(8)
    expect(before.unconfiguredAgents.items.every((item) => item.projectId === projectId)).toBe(true)

    // 一键设为平台全局默认（模型模块的那个动作）→ 未配置的实例靠回退链立即可用
    expect(
      (
        await inject({
          method: 'PUT',
          url: '/api/model-routing',
          payload: { defaultModelId: 's11-model' },
        })
      ).statusCode,
    ).toBe(200)

    const after = (await inject({ method: 'GET', url: '/api/model-config/overview' })).json<OverviewBody>()
    expect(after.unconfiguredAgents.total).toBe(0)

    // 未配置 → 生效模型非空（回退到平台默认）
    const dev = (await inject({ method: 'GET', url: `/api/projects/${projectId}/team/dev_1` })).json<{
      effective: { model: string | null }
      effectiveModelAvailable: boolean
    }>()
    expect(dev.effective.model).toBe('s11-model')
    expect(dev.effectiveModelAvailable).toBe(true)

    // 复位：清空平台默认 → 计数回到 8
    await inject({ method: 'PUT', url: '/api/model-routing', payload: { defaultModelId: null } })
    expect(
      (await inject({ method: 'GET', url: '/api/model-config/overview' })).json<OverviewBody>().unconfiguredAgents.total,
    ).toBe(8)

    await inject({ method: 'DELETE', url: `/api/projects/${projectId}` })
  })
})
