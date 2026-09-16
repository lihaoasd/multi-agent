import type { AppDeps } from '../src/bootstrap/composition-root'
import type { Credential } from '../src/ports/model-config'
import type { ProviderKind } from '../src/ports/model'

/**
 * 测试用"显式配置模型"工具（S10 口径：**Agent 默认不配置模型**，出厂不自动创建任何供应商）。
 * 依赖出厂默认值的用例一律改为显式调用本工具，顺带把"未配置 → ERR_MODEL"路径也覆盖到。
 */

export interface TestModelSpec {
  readonly providerId?: string
  readonly modelId?: string
  /** 默认 `ollama`：唯一免密钥的内置 kind（集成测试不联网，调用由替身网关承接） */
  readonly kind?: ProviderKind
  readonly baseUrl?: string
  readonly credential?: Credential
  readonly model?: string
  /** 是否设为平台全局默认（`routing.defaultModelId`），默认 true */
  readonly asPlatformDefault?: boolean
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

  if (spec.asPlatformDefault !== false) {
    const routing = await deps.modelConfig.updateRouting({ defaultModelId: modelId, stepOverrides: {} })
    if (!routing.ok) throw new Error(`测试模型配置失败（平台默认）：${routing.error.message}`)
  }

  return { providerId, modelId }
}
