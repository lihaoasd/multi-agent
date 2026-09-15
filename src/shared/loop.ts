/**
 * agent loop 与步骤名的平台常量（真源：docs/design/agent-runtime.md §3）。
 * ⚠️ 这些是**当前**内置集合；S4 接入 `LoopRegistry` 后，校验以注册表为准（此处退化为默认值）。
 */
export const LOOP_STRATEGY_NAMES = ['direct', 'reflective', 'plan-execute'] as const
export type BuiltinLoopStrategy = (typeof LOOP_STRATEGY_NAMES)[number]

/** loop 步骤名（用于 stepModelOverride / routing.stepOverrides） */
export const LOOP_STEP_NAMES = ['plan', 'act', 'critique'] as const
export type LoopStepName = (typeof LOOP_STEP_NAMES)[number]

/** loop 通用参数取值范围（model-config.md §8 #14） */
export const LOOP_PARAM_LIMITS = {
  maxIterations: { min: 1, max: 20 },
  toolBudget: { min: 0, max: 200 },
} as const

/** 提示词默认长度上限（可被 MODELS__MAX_PROMPT_CHARS 覆盖） */
export const DEFAULT_MAX_PROMPT_CHARS = 20_000

/** 滚动摘要触发阈值：累计多少条未摘要消息后生成摘要（memory.md §3.1 的"~40 条"） */
export const DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40

/** 摘要请求里会话原文的最大字符数（成本护栏） */
export const SUMMARY_PROMPT_CHARS = 8_000

/** 平台内置的 7 个基础工具包（全员必选，D19-②） */
export const BASE_TOOL_PACKAGES = ['fs', 'cmd', 'memory', 'session', 'artifact', 'approval', 'task'] as const
