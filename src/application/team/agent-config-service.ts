import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { IdGenerator } from '../../ports/id'
import type { ConfigAuditWriter, ModelCatalog } from '../../ports/model-config'
import type {
  LoopConfig,
  RoleTemplate,
  RoleTemplateCreateInput,
  RoleTemplatePatch,
  RoleTemplateStore,
} from '../../ports/role-templates'
import { err, ok, type Result } from '../../shared/result'
import { validateTemplateCreate, validateTemplatePatch, type AgentConfigValidationContext } from './validate-agent-config'
import type { TemplateReferenceQuery } from './template-references'

export interface AgentConfigServiceOptions {
  readonly store: RoleTemplateStore
  readonly catalog: ModelCatalog
  readonly audit: ConfigAuditWriter
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
  /** 删除前的引用保护（被项目实例引用 → 拒绝删除并点名，S11） */
  readonly references: TemplateReferenceQuery
}

/** 模板视图：附带模型解析结果，便于 UI 标「模型已移除/已停用」 */
export interface RoleTemplateView {
  readonly roleId: string
  readonly name: string
  readonly category: string
  readonly scenario: string
  readonly description: string
  readonly systemPrompt: string
  readonly defaultModel: string | null
  readonly defaultModelLabel: string | null
  readonly defaultModelAvailable: boolean
  readonly defaultLoop: LoopConfig
  readonly packages: readonly string[]
  readonly tools: readonly string[]
  readonly artifactTypes: readonly string[]
  readonly defaultApprovalRules: readonly string[]
  readonly source: 'builtin' | 'user'
  readonly enabled: boolean
  readonly copyFrom?: string
  /** 提示词/loop 等身份字段可编辑（UI 置灰依据；内置模板恒为 false） */
  readonly editable: boolean
  /** 默认模型可编辑：**内置模板也可改**（经数据目录运行时覆盖，S11/D22-③） */
  readonly modelEditable: boolean
  /** 可删除：仅用户模板（内置模板只能停用） */
  readonly deletable: boolean
}

export interface BulkModelResult {
  readonly updated: readonly string[]
  readonly skipped: readonly { readonly roleId: string; readonly code: string; readonly message: string }[]
}

export interface AgentConfigService {
  list(scenario?: string): Promise<Result<readonly RoleTemplateView[]>>
  get(roleId: string): Promise<Result<RoleTemplateView>>
  create(input: RoleTemplateCreateInput): Promise<Result<RoleTemplateView>>
  update(roleId: string, patch: RoleTemplatePatch): Promise<Result<RoleTemplateView>>
  setEnabled(roleId: string, enabled: boolean): Promise<Result<RoleTemplateView>>
  /** 删除用户模板（`confirm` 必须为 true；被项目实例引用 → `ERR_CONFLICT` + referrers） */
  remove(roleId: string, confirm: boolean): Promise<Result<{ readonly deleted: string }>>
  /** 批量设置默认模型（内置与用户模板均可；`defaultModel: null` = 清空默认模型） */
  bulkSetDefaultModel(roleIds: readonly string[], defaultModel: string | null): Promise<Result<BulkModelResult>>
  listHistory(roleId: string): Promise<Result<readonly string[]>>
}

/** 单次批量改模型的上限（防御性；UI 也不会超过模板总数） */
const BULK_LIMIT = 200

/**
 * Agent 配置服务（FR-35 / agent-templates.md §4）：
 * 本轮开放**提示词 / loop / 模型**三项；内置模板不可改（须"基于内置复制新建"）。
 * 生效范围：模板编辑只影响**此后新建的实例**（快照，D16-⑤），写入即广播 `agent-config.updated`。
 */
export function createAgentConfigService(options: AgentConfigServiceOptions): AgentConfigService {
  const { store, catalog, audit, ids, clock, config } = options
  const platform = config.get()

  const validationContext = async (): Promise<AgentConfigValidationContext> => {
    const loaded = await catalog.current()
    const enabledModels = new Set(
      loaded.ok ? loaded.value.snapshot.models.filter((entry) => entry.enabled).map((entry) => entry.id) : [],
    )
    return {
      isModelEnabled: (modelId: string) => enabledModels.has(modelId),
      maxPromptChars: platform.models.maxPromptChars,
    }
  }

  const toView = async (template: RoleTemplate): Promise<RoleTemplateView> => {
    const loaded = await catalog.current()
    const model = loaded.ok
      ? loaded.value.snapshot.models.find((entry) => entry.id === template.defaultModel)
      : undefined
    return {
      roleId: template.roleId,
      name: template.name,
      category: template.category,
      scenario: template.scenario,
      description: template.description,
      systemPrompt: template.systemPrompt,
      defaultModel: template.defaultModel,
      defaultModelLabel: model?.displayName ?? null,
      defaultModelAvailable: model !== undefined && model.enabled,
      defaultLoop: template.defaultLoop,
      packages: template.packages,
      tools: template.tools,
      artifactTypes: template.artifactTypes,
      defaultApprovalRules: template.defaultApprovalRules,
      source: template.source,
      enabled: template.enabled,
      ...(template.copyFrom === undefined ? {} : { copyFrom: template.copyFrom }),
      editable: template.source === 'user',
      modelEditable: true,
      deletable: template.source === 'user',
    }
  }

  const writeAudit = async (
    action: 'create' | 'update' | 'delete',
    roleId: string,
    diff: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    await audit.appendAudit({
      id: ids.next('cfg'),
      ts: clock.now().toISOString(),
      actor: 'user',
      scope: 'template',
      target: { kind: 'agent-template', id: roleId },
      action,
      diff,
    })
  }

  return {
    async list(scenario?: string): Promise<Result<readonly RoleTemplateView[]>> {
      const templates = await store.list()
      if (!templates.ok) return templates
      const filtered =
        scenario === undefined ? templates.value : templates.value.filter((item) => item.scenario === scenario)
      const views: RoleTemplateView[] = []
      for (const template of filtered) views.push(await toView(template))
      return ok(views)
    },

    async get(roleId: string): Promise<Result<RoleTemplateView>> {
      const template = await store.get(roleId)
      return template.ok ? ok(await toView(template.value)) : template
    },

    async create(input: RoleTemplateCreateInput): Promise<Result<RoleTemplateView>> {
      const context = await validationContext()
      const validated = validateTemplateCreate(input, context)
      if (!validated.ok) return validated
      const created = await store.create(validated.value)
      if (!created.ok) return created
      await writeAudit('create', created.value.roleId, {
        copyFrom: input.copyFrom,
        fields: Object.keys(input).filter((key) => key !== 'copyFrom' && key !== 'roleId'),
      })
      return ok(await toView(created.value))
    },

    async update(roleId: string, patch: RoleTemplatePatch): Promise<Result<RoleTemplateView>> {
      const existing = await store.get(roleId)
      if (!existing.ok) return existing
      const context = await validationContext()
      if (existing.value.source === 'builtin') {
        // 内置模板：身份字段（提示词/loop）只读；**默认模型可改**（写数据目录覆盖，D22-③）
        if (patch.systemPrompt !== undefined || patch.defaultLoop !== undefined) {
          return err('ERR_FORBIDDEN', '内置模板的提示词/loop 不可修改；请基于内置复制新建', { roleId })
        }
        if (patch.defaultModel === undefined) {
          return err('ERR_VALIDATION', '没有可提交的字段', { roleId })
        }
        const validated = validateTemplatePatch({ defaultModel: patch.defaultModel }, context)
        if (!validated.ok) return validated
        const updated = await store.setModelDefault(roleId, validated.value.defaultModel ?? null)
        if (!updated.ok) return updated
        await writeAudit('update', roleId, { fields: ['defaultModel'], defaultModel: validated.value.defaultModel ?? null })
        return ok(await toView(updated.value))
      }
      const validated = validateTemplatePatch(patch, context)
      if (!validated.ok) return validated
      const updated = await store.update(roleId, validated.value)
      if (!updated.ok) return updated
      await writeAudit('update', roleId, { fields: Object.keys(validated.value) })
      return ok(await toView(updated.value))
    },

    async setEnabled(roleId: string, enabled: boolean): Promise<Result<RoleTemplateView>> {
      const updated = await store.setEnabled(roleId, enabled)
      if (!updated.ok) return updated
      await writeAudit('update', roleId, { fields: ['enabled'], enabled })
      return ok(await toView(updated.value))
    },

    async remove(roleId: string, confirm: boolean): Promise<Result<{ readonly deleted: string }>> {
      const existing = await store.get(roleId)
      if (!existing.ok) return existing
      if (existing.value.source === 'builtin') {
        return err('ERR_FORBIDDEN', '内置模板只能停用，不能删除', { roleId })
      }
      if (!confirm) {
        return err('ERR_VALIDATION', '删除模板需要二次确认（confirm=true）', { roleId })
      }
      const referrers = await options.references.findTemplateReferrers(roleId)
      if (referrers.length > 0) {
        return err('ERR_CONFLICT', '该模板被项目实例引用，删除前请先从这些项目移除成员', {
          roleId,
          referrers,
        })
      }
      const removed = await store.delete(roleId)
      if (!removed.ok) return removed
      await writeAudit('delete', roleId, { source: existing.value.source })
      return ok(removed.value)
    },

    async bulkSetDefaultModel(
      roleIds: readonly string[],
      defaultModel: string | null,
    ): Promise<Result<BulkModelResult>> {
      const wanted = [...new Set(roleIds)]
      if (wanted.length === 0) {
        return err('ERR_VALIDATION', '至少选择一个模板')
      }
      if (wanted.length > BULK_LIMIT) {
        return err('ERR_VALIDATION', `单次最多配置 ${BULK_LIMIT} 个模板`, { count: wanted.length })
      }
      const context = await validationContext()
      const validated = validateTemplatePatch({ defaultModel }, context)
      if (!validated.ok) return validated
      const model = validated.value.defaultModel ?? null

      const updated: string[] = []
      const skipped: { roleId: string; code: string; message: string }[] = []
      for (const roleId of wanted) {
        const result = await store.setModelDefault(roleId, model)
        if (!result.ok) {
          skipped.push({ roleId, code: result.error.code, message: result.error.message })
          continue
        }
        updated.push(roleId)
        await writeAudit('update', roleId, { fields: ['defaultModel'], defaultModel: model })
      }
      return ok({ updated, skipped })
    },

    async listHistory(roleId: string): Promise<Result<readonly string[]>> {
      const existing = await store.get(roleId)
      if (!existing.ok) return existing
      return ok(await store.listHistory(roleId))
    },
  }
}
