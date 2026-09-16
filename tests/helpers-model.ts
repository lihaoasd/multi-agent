import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../src/bootstrap/composition-root'
import type { Credential } from '../src/ports/model-config'
import type { ProviderKind } from '../src/ports/model'

/**
 * 测试用"显式配置模型"工具（S10 口径：**Agent 默认不配置模型**，出厂不自动创建任何供应商）。
 * S14 起不再有"平台默认模型"这一级，因此需要模型的用例必须把模型**写到模板默认或实例覆盖**上
 * （本工具只负责登记供应商 + 模型条目；写入动作由调用方用模板/实例 API 完成）。
 */

export interface TestModelSpec {
  readonly providerId?: string
  readonly modelId?: string
  /** 默认 `ollama`：唯一免密钥的内置 kind（集成测试不联网，调用由替身网关承接） */
  readonly kind?: ProviderKind
  readonly baseUrl?: string
  readonly credential?: Credential
  readonly model?: string
}

export interface TestModelHandle {
  readonly providerId: string
  readonly modelId: string
}

export async function configureTestModel(deps: AppDeps, spec: TestModelSpec = {}): Promise<TestModelHandle> {
  const providerId = spec.providerId ?? 'test-provider'
  const modelId = spec.modelId ?? 'test-model'
  const kind = spec.kind ?? 'ollama'

  const provider = await deps.modelConfig.createProvider({
    id: providerId,
    name: providerId,
    kind,
    baseUrl: spec.baseUrl ?? 'http://127.0.0.1:11434',
    credential: spec.credential ?? { mode: 'file', value: '' },
  })
  if (!provider.ok) throw new Error(`测试模型配置失败（供应商）：${provider.error.message}`)

  const model = await deps.modelConfig.createModel({
    id: modelId,
    providerId,
    model: spec.model ?? modelId,
    displayName: modelId,
  })
  if (!model.ok) throw new Error(`测试模型配置失败（模型条目）：${model.error.message}`)

  return { providerId, modelId }
}

/**
 * 把某个模型写到**全部内置模板的默认模型**上（S14 起没有"平台默认模型"这一级，
 * 因此需要让"新建项目"的实例快照带上模型；必须在创建项目**之前**调用）。
 */
export async function applyModelToAllTemplates(app: FastifyInstance, modelId: string): Promise<number> {
  const listed = await app.inject({ method: 'GET', url: '/api/agent-templates' })
  if (listed.statusCode !== 200) throw new Error(`测试模型配置失败（读取模板）：HTTP ${listed.statusCode}`)
  const templates = JSON.parse(listed.body) as Array<{ roleId: string; source: string }>
  const roleIds = templates.filter((item) => item.source === 'builtin').map((item) => item.roleId)
  const applied = await app.inject({
    method: 'POST',
    url: '/api/agent-templates/bulk-model',
    payload: { roleIds, defaultModel: modelId },
  })
  if (applied.statusCode !== 200) throw new Error(`测试模型配置失败（模板默认模型）：HTTP ${applied.statusCode}`)
  return roleIds.length
}
