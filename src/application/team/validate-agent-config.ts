import type { LoopConfig, RoleTemplateCreateInput, RoleTemplatePatch } from '../../ports/role-templates'
import { LOOP_PARAM_LIMITS, LOOP_STRATEGY_NAMES } from '../../shared/loop'
import { err, ok, type Result } from '../../shared/result'
import { ID_PATTERN } from '../model-config/validate'

export interface AgentConfigValidationContext {
  /** 模型条目是否存在且启用（查 ModelCatalog 快照） */
  readonly isModelEnabled: (modelId: string) => boolean
  readonly maxPromptChars: number
  /** 已注册的 loop 策略名；缺省用内置集合（S4 接入 LoopRegistry 后由注册表提供） */
  readonly strategies?: readonly string[]
}

/** loop 校验（model-config.md §8 #14） */
export function validateLoopConfig(loop: LoopConfig, ctx: AgentConfigValidationContext): Result<LoopConfig> {
  const strategies = ctx.strategies ?? LOOP_STRATEGY_NAMES
  if (!strategies.includes(loop.strategy)) {
    return err('ERR_VALIDATION', `未注册的 loop 策略：${loop.strategy}`, { available: strategies })
  }

  const params = loop.params as {
    maxIterations?: unknown
    toolBudget?: unknown
    stepModelOverride?: unknown
    interruptibleAfterStep?: unknown
  }

  const maxIterations = params.maxIterations
  if (maxIterations !== undefined) {
    if (
      typeof maxIterations !== 'number' ||
      !Number.isInteger(maxIterations) ||
      maxIterations < LOOP_PARAM_LIMITS.maxIterations.min ||
      maxIterations > LOOP_PARAM_LIMITS.maxIterations.max
    ) {
      return err(
        'ERR_VALIDATION',
        `maxIterations 必须是 ${LOOP_PARAM_LIMITS.maxIterations.min}~${LOOP_PARAM_LIMITS.maxIterations.max} 的整数`,
        { maxIterations },
      )
    }
  }

  const toolBudget = params.toolBudget
  if (toolBudget !== undefined) {
    if (
      typeof toolBudget !== 'number' ||
      !Number.isInteger(toolBudget) ||
      toolBudget < LOOP_PARAM_LIMITS.toolBudget.min ||
      toolBudget > LOOP_PARAM_LIMITS.toolBudget.max
    ) {
      return err(
        'ERR_VALIDATION',
        `toolBudget 必须是 ${LOOP_PARAM_LIMITS.toolBudget.min}~${LOOP_PARAM_LIMITS.toolBudget.max} 的整数`,
        { toolBudget },
      )
    }
  }

  const override = params.stepModelOverride
  if (override !== undefined) {
    if (typeof override !== 'string' || !ctx.isModelEnabled(override)) {
      return err('ERR_VALIDATION', `stepModelOverride 必须是已启用的模型条目：${String(override)}`, {
        stepModelOverride: override,
      })
    }
  }

  return ok(loop)
}

/** 提示词校验（model-config.md §8 #13）：非空 + 长度上限；**不引入占位符语法** */
export function validateSystemPrompt(prompt: string, maxPromptChars: number): Result<string> {
  if (prompt.trim().length === 0) {
    return err('ERR_VALIDATION', '系统提示词不能为空')
  }
  if (prompt.length > maxPromptChars) {
    return err('ERR_VALIDATION', `系统提示词超长：${prompt.length} > ${maxPromptChars}`, {
      length: prompt.length,
      maxPromptChars,
    })
  }
  return ok(prompt)
}

function validateModelRef(
  modelId: string | null | undefined,
  ctx: AgentConfigValidationContext,
): Result<string | null | undefined> {
  if (modelId === undefined || modelId === null) return ok(modelId)
  if (!ctx.isModelEnabled(modelId)) {
    return err('ERR_VALIDATION', `模型条目不存在或未启用：${modelId}`, { modelId })
  }
  return ok(modelId)
}

/** 模板编辑校验（仅开放三项：提示词 / loop / 模型） */
export function validateTemplatePatch(
  patch: RoleTemplatePatch,
  ctx: AgentConfigValidationContext,
): Result<RoleTemplatePatch> {
  const result: { systemPrompt?: string; defaultLoop?: LoopConfig; defaultModel?: string | null } = {}

  if (patch.systemPrompt !== undefined) {
    const prompt = validateSystemPrompt(patch.systemPrompt, ctx.maxPromptChars)
    if (!prompt.ok) return prompt
    result.systemPrompt = prompt.value
  }
  if (patch.defaultLoop !== undefined) {
    const loop = validateLoopConfig(patch.defaultLoop, ctx)
    if (!loop.ok) return loop
    result.defaultLoop = loop.value
  }
  if (patch.defaultModel !== undefined) {
    const model = validateModelRef(patch.defaultModel, ctx)
    if (!model.ok) return model
    result.defaultModel = model.value ?? null
  }

  if (Object.keys(result).length === 0) {
    return err('ERR_VALIDATION', '没有可提交的字段（仅支持 systemPrompt / defaultLoop / defaultModel）')
  }
  return ok(result)
}

/** 模板新建校验：新 roleId 合法 + 三项字段（若有）合法 */
export function validateTemplateCreate(
  input: RoleTemplateCreateInput,
  ctx: AgentConfigValidationContext,
): Result<RoleTemplateCreateInput> {
  if (!ID_PATTERN.test(input.roleId)) {
    return err('ERR_VALIDATION', `roleId 不合法（小写字母/数字/连字符，2~32 位）：${input.roleId}`, {
      roleId: input.roleId,
    })
  }
  if (!ID_PATTERN.test(input.copyFrom)) {
    return err('ERR_VALIDATION', `copyFrom 不合法：${input.copyFrom}`, { copyFrom: input.copyFrom })
  }
  if (input.systemPrompt !== undefined) {
    const prompt = validateSystemPrompt(input.systemPrompt, ctx.maxPromptChars)
    if (!prompt.ok) return prompt
  }
  if (input.defaultLoop !== undefined) {
    const loop = validateLoopConfig(input.defaultLoop, ctx)
    if (!loop.ok) return loop
  }
  if (input.defaultModel !== undefined) {
    const model = validateModelRef(input.defaultModel, ctx)
    if (!model.ok) return model
  }
  return ok(input)
}
