import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { IdGenerator } from '../../ports/id'
import type { ConfigAuditWriter, ModelCatalog } from '../../ports/model-config'
import type { ProjectStore, RoleInstance } from '../../ports/project'
import type { LoopConfig, RoleTemplateStore } from '../../ports/role-templates'
import { err, ok, type Result } from '../../shared/result'
import {
  describeInstanceOverrides,
  resolveEffectiveAgentConfig,
  type EffectiveAgentConfig,
} from './effective-config'
import { validateLoopConfig, validateSystemPrompt } from './validate-agent-config'

export interface TeamServiceOptions {
  readonly store: ProjectStore
  readonly roleTemplates: RoleTemplateStore
  readonly catalog: ModelCatalog
  readonly audit: ConfigAuditWriter
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
}

export interface InstanceView {
  readonly instanceId: string
  readonly roleTemplateId: string
  readonly displayName: string
  readonly templateName: string
  /** 模板已从库中移除（快照仍在，D16-⑤） */
  readonly templateMissing: boolean
  readonly enabled: boolean
  readonly configVersion: number
  readonly createdAt: string
  readonly promptOverride: string | null
  readonly modelOverride: string | null
  readonly loopOverride: LoopConfig | null
  readonly overrides: readonly string[]
  readonly effective: EffectiveAgentConfig
  readonly effectiveModelLabel: string | null
  readonly effectiveModelAvailable: boolean
}

export interface AddInstanceInput {
  readonly roleTemplateId: string
  readonly displayName?: string
}

/** 三项覆盖（FR-35）：`null` = 清除覆盖、回到模板快照 */
export interface InstancePatch {
  readonly displayName?: string
  readonly prompt?: string | null
  readonly model?: string | null
  readonly loop?: LoopConfig | null
  readonly enabled?: boolean
}

export interface TeamService {
  listInstances(projectId: string): Promise<Result<readonly InstanceView[]>>
  getInstance(projectId: string, instanceId: string): Promise<Result<InstanceView>>
  addInstance(projectId: string, input: AddInstanceInput): Promise<Result<InstanceView>>
  patchInstance(projectId: string, instanceId: string, patch: InstancePatch): Promise<Result<InstanceView>>
  setEnabled(projectId: string, instanceId: string, enabled: boolean): Promise<Result<InstanceView>>
  effectiveConfig(projectId: string, instanceId: string): Promise<Result<EffectiveAgentConfig>>
}

const MAX_DISPLAY_NAME = 40

/**
 * 团队服务（prd FR-02 / D16-⑤ / D14-3 / D14-9）：
 * - 新增实例时**快照**模板默认值（此后模板变更不影响实例）；
 * - 每项目每模板至多 1 个实例（MVP）；
 * - 覆盖三项（提示词/loop/模型）走与模板相同的校验器，`configVersion` +1 并留审计；
 * - 删除=停用（保留全部数据，可重新启用）。
 */
export function createTeamService(options: TeamServiceOptions): TeamService {
  const { store, roleTemplates, catalog, audit, ids, clock, config } = options

  const validationContext = async (): Promise<{
    isModelEnabled: (modelId: string) => boolean
    maxPromptChars: number
  }> => {
    const loaded = await catalog.current()
    const enabled = new Set(
      loaded.ok ? loaded.value.snapshot.models.filter((entry) => entry.enabled).map((entry) => entry.id) : [],
    )
    return {
      isModelEnabled: (modelId: string) => enabled.has(modelId),
      maxPromptChars: config.get().models.maxPromptChars,
    }
  }

  const platformDefaultModel = async (): Promise<string | null> => {
    const loaded = await catalog.current()
    return loaded.ok ? loaded.value.snapshot.routing.defaultModelId : null
  }

  const toView = async (instance: RoleInstance): Promise<InstanceView> => {
    const templates = await roleTemplates.list()
    const template = templates.ok ? templates.value.find((item) => item.roleId === instance.roleTemplateId) : undefined
    const loaded = await catalog.current()
    const model = loaded.ok
      ? loaded.value.snapshot.models.find((entry) => entry.id === (instance.model ?? instance.snapshot.defaultModel))
      : undefined
    const effective = resolveEffectiveAgentConfig(instance, { defaultModelId: await platformDefaultModel() })
    return {
      instanceId: instance.instanceId,
      roleTemplateId: instance.roleTemplateId,
      displayName: instance.displayName,
      templateName: instance.snapshot.templateName,
      templateMissing: template === undefined,
      enabled: instance.enabled,
      configVersion: instance.configVersion,
      createdAt: instance.createdAt,
      promptOverride: instance.prompt,
      modelOverride: instance.model,
      loopOverride: instance.loop,
      overrides: describeInstanceOverrides(instance),
      effective,
      effectiveModelLabel: model?.displayName ?? null,
      effectiveModelAvailable: model !== undefined && model.enabled,
    }
  }

  const findInstance = (team: readonly RoleInstance[], instanceId: string): RoleInstance | undefined =>
    team.find((instance) => instance.instanceId === instanceId)

  const writeAudit = async (
    projectId: string,
    instanceId: string,
    fields: readonly string[],
  ): Promise<void> => {
    await audit.appendAudit({
      id: ids.next('cfg'),
      ts: clock.now().toISOString(),
      actor: 'user',
      scope: 'instance',
      target: { kind: 'agent-instance', id: instanceId },
      action: 'update',
      diff: { fields },
      projectId,
      instanceId,
    })
  }

  return {
    async listInstances(projectId: string): Promise<Result<readonly InstanceView[]>> {
      const meta = await store.get(projectId)
      if (!meta.ok) return meta
      const views: InstanceView[] = []
      for (const instance of meta.value.team) views.push(await toView(instance))
      return ok(views)
    },

    async getInstance(projectId: string, instanceId: string): Promise<Result<InstanceView>> {
      const meta = await store.get(projectId)
      if (!meta.ok) return meta
      const instance = findInstance(meta.value.team, instanceId)
      if (instance === undefined) {
        return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
      }
      return ok(await toView(instance))
    },

    async addInstance(projectId: string, input: AddInstanceInput): Promise<Result<InstanceView>> {
      const templates = await roleTemplates.list()
      if (!templates.ok) return templates
      const template = templates.value.find((item) => item.roleId === input.roleTemplateId)
      if (template === undefined) {
        return err('ERR_NOT_FOUND', `角色模板不存在：${input.roleTemplateId}`, {
          roleTemplateId: input.roleTemplateId,
        })
      }
      if (!template.enabled) {
        return err('ERR_VALIDATION', `角色模板已停用：${input.roleTemplateId}`)
      }
      const displayName = input.displayName?.trim()
      if (displayName !== undefined) {
        if (displayName.length === 0) return err('ERR_VALIDATION', '实例名称不能为空')
        if (displayName.length > MAX_DISPLAY_NAME) {
          return err('ERR_VALIDATION', `实例名称过长（≤ ${MAX_DISPLAY_NAME} 字）`)
        }
      }

      const createdAt = clock.now().toISOString()
      const instance: RoleInstance = {
        instanceId: `${template.roleId}_1`,
        roleTemplateId: template.roleId,
        displayName: displayName ?? template.name,
        prompt: null,
        model: null,
        loop: null,
        enabled: true,
        configVersion: 1,
        createdAt,
        snapshot: {
          roleTemplateId: template.roleId,
          templateName: template.name,
          systemPrompt: template.systemPrompt,
          defaultModel: template.defaultModel,
          defaultLoop: template.defaultLoop,
          packages: template.packages,
          tools: template.tools,
          artifactTypes: template.artifactTypes,
          defaultApprovalRules: template.defaultApprovalRules,
          capturedAt: createdAt,
        },
      }

      const updated = await store.update(projectId, (meta) => {
        if (meta.team.some((item) => item.roleTemplateId === template.roleId)) {
          return err('ERR_CONFLICT', `该项目已存在该角色的实例（MVP 每模板至多 1 个）：${template.roleId}`, {
            roleTemplateId: template.roleId,
          })
        }
        return ok({ ...meta, team: [...meta.team, instance] })
      })
      if (!updated.ok) return updated
      await writeAudit(projectId, instance.instanceId, ['created'])
      return ok(await toView(instance))
    },

    async patchInstance(
      projectId: string,
      instanceId: string,
      patch: InstancePatch,
    ): Promise<Result<InstanceView>> {
      const context = await validationContext()
      const fields: string[] = []

      let nextDisplayName: string | undefined
      if (patch.displayName !== undefined) {
        const trimmed = patch.displayName.trim()
        if (trimmed.length === 0) return err('ERR_VALIDATION', '实例名称不能为空')
        if (trimmed.length > MAX_DISPLAY_NAME) {
          return err('ERR_VALIDATION', `实例名称过长（≤ ${MAX_DISPLAY_NAME} 字）`)
        }
        nextDisplayName = trimmed
        fields.push('displayName')
      }

      let nextPrompt: string | null | undefined
      if (patch.prompt !== undefined) {
        if (patch.prompt === null) {
          nextPrompt = null
        } else {
          const validated = validateSystemPrompt(patch.prompt, context.maxPromptChars)
          if (!validated.ok) return validated
          nextPrompt = validated.value
        }
        fields.push('prompt')
      }

      let nextModel: string | null | undefined
      if (patch.model !== undefined) {
        if (patch.model === null) {
          nextModel = null
        } else {
          if (!context.isModelEnabled(patch.model)) {
            return err('ERR_VALIDATION', `模型条目不存在或未启用：${patch.model}`, { modelId: patch.model })
          }
          nextModel = patch.model
        }
        fields.push('model')
      }

      let nextLoop: LoopConfig | null | undefined
      if (patch.loop !== undefined) {
        if (patch.loop === null) {
          nextLoop = null
        } else {
          const validated = validateLoopConfig(patch.loop, context)
          if (!validated.ok) return validated
          nextLoop = validated.value
        }
        fields.push('loop')
      }

      if (patch.enabled !== undefined) fields.push('enabled')
      if (fields.length === 0) {
        return err('ERR_VALIDATION', '没有可提交的字段（displayName / prompt / model / loop / enabled）')
      }

      const updated = await store.update(projectId, (meta) => {
        const instance = findInstance(meta.team, instanceId)
        if (instance === undefined) {
          return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
        }
        const next: RoleInstance = {
          ...instance,
          ...(nextDisplayName === undefined ? {} : { displayName: nextDisplayName }),
          ...(nextPrompt === undefined ? {} : { prompt: nextPrompt }),
          ...(nextModel === undefined ? {} : { model: nextModel }),
          ...(nextLoop === undefined ? {} : { loop: nextLoop }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          // 覆盖字段变化即版本 +1（提示词/模型/循环三选一；仅改名字或停用不递增）
          configVersion:
            nextPrompt === undefined && nextModel === undefined && nextLoop === undefined
              ? instance.configVersion
              : instance.configVersion + 1,
        }
        return ok({ ...meta, team: meta.team.map((item) => (item.instanceId === instanceId ? next : item)) })
      })
      if (!updated.ok) return updated
      await writeAudit(projectId, instanceId, fields)
      const view = updated.value.team.find((item) => item.instanceId === instanceId)
      if (view === undefined) return err('ERR_INTERNAL', '实例更新后丢失', { instanceId })
      return ok(await toView(view))
    },

    async setEnabled(projectId: string, instanceId: string, enabled: boolean): Promise<Result<InstanceView>> {
      const updated = await store.update(projectId, (meta) => {
        const instance = findInstance(meta.team, instanceId)
        if (instance === undefined) {
          return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
        }
        if (instance.enabled === enabled) {
          return err('ERR_CONFLICT', enabled ? '实例已是启用状态' : '实例已停用', { instanceId })
        }
        return ok({
          ...meta,
          team: meta.team.map((item) => (item.instanceId === instanceId ? { ...item, enabled } : item)),
        })
      })
      if (!updated.ok) return updated
      await writeAudit(projectId, instanceId, [enabled ? 'enabled' : 'disabled'])
      const view = updated.value.team.find((item) => item.instanceId === instanceId)
      if (view === undefined) return err('ERR_INTERNAL', '实例更新后丢失', { instanceId })
      return ok(await toView(view))
    },

    async effectiveConfig(projectId: string, instanceId: string): Promise<Result<EffectiveAgentConfig>> {
      const meta = await store.get(projectId)
      if (!meta.ok) return meta
      const instance = findInstance(meta.value.team, instanceId)
      if (instance === undefined) {
        return err('ERR_NOT_FOUND', `实例不存在：${instanceId}`, { projectId, instanceId })
      }
      return ok(resolveEffectiveAgentConfig(instance, { defaultModelId: await platformDefaultModel() }))
    },
  }
}
