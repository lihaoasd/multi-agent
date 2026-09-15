import type { ChatMessage } from '../../ports/model'
import type { AgentLoopStrategy, LoopRunEnv } from './loop'
import { ok, type Result } from '../../shared/result'

/**
 * 三个内置 loop 策略（agent-runtime.md §3 的**真实形态**，替换原先的"提示级差异"）：
 * - `direct`：一次直接回答；若模型要工具，则执行**一轮**工具后再汇总一次（共 ≤2 次模型调用）。
 * - `reflective`：初稿 → 自查（critique）→ 修订；`maxIterations` 控制自查-修订轮数（默认 1）。
 * - `plan-execute`：让模型产出**结构化计划**（JSON）→ 落 `plan` 事件 → 逐步执行 → 阶段小结；
 *   `maxIterations` 限制步数、`toolBudget` 限制工具调用总数。
 */

function textOf(result: { text: string }): string {
  return result.text.trim()
}

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args)
    return json.length > 400 ? `${json.slice(0, 400)}…` : json
  } catch {
    return String(args)
  }
}

async function emitThought(env: LoopRunEnv, text: string): Promise<void> {
  if (text.trim().length === 0) return
  await env.emit({ kind: 'thought', turn: env.turn, payload: { text } })
}

async function emitMessage(env: LoopRunEnv, text: string, modelId: string | null, loopStep: string): Promise<void> {
  const body = text.trim().length === 0 ? '（模型没有返回内容）' : text
  await env.emit({
    kind: 'message',
    turn: env.turn,
    payload: {
      role: 'agent',
      sender: env.instanceId,
      text: body,
      content: { text: body },
      model: modelId,
      loopStep,
    },
  })
}

/** 执行工具调用并写出 tool_call/tool_result 事件；返回给模型看的文本结果 */
async function runToolCalls(env: LoopRunEnv, calls: readonly { callId: string; name: string; args: unknown }[]): Promise<readonly string[]> {
  const results: string[] = []
  for (const call of calls) {
    if (env.budget.used() >= env.toolBudget) {
      results.push(`（工具预算 ${env.toolBudget} 已用尽，${call.name} 未执行）`)
      continue
    }
    await env.emit({
      kind: 'tool_call',
      turn: env.turn,
      payload: { tool: call.name, callId: call.callId, input: summarizeArgs(call.args) },
    })
    const outcome = await env.runTool(call)
    env.budget.spend(1)
    const okFlag = outcome.ok && outcome.value.ok
    const text = outcome.ok ? outcome.value.text : `[${outcome.error.code}] ${outcome.error.message}`
    await env.emit({
      kind: 'tool_result',
      turn: env.turn,
      payload: {
        tool: call.name,
        callId: call.callId,
        ok: okFlag,
        summary: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      },
    })
    results.push(`工具 ${call.name} 结果：\n${text}`)
  }
  return results
}

function withToolResults(messages: readonly ChatMessage[], draft: string, toolResults: readonly string[]): readonly ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: draft.length > 0 ? draft : '（我先调用工具获取信息）' },
    { role: 'user', content: `工具执行结果如下，请据此给出最终答复：\n\n${toolResults.join('\n\n')}` },
  ]
}

/** direct：单轮直答（最多一轮工具） */
export function createDirectStrategy(): AgentLoopStrategy {
  return {
    name: 'direct',
    description: '单轮直答：一次模型调用；如需要工具则执行一轮工具后再汇总',
    async run(env: LoopRunEnv): Promise<Result<void>> {
      const first = await env.callModel({
        messages: env.contextMessages,
        tools: env.toolSchemas,
        ...(env.stepModelOverride === undefined ? {} : { modelOverride: env.stepModelOverride }),
        purpose: '直接回答',
      })
      if (!first.ok) return first
      await emitThought(env, first.value.reasoning)

      if (first.value.toolCalls.length === 0) {
        await emitMessage(env, textOf(first.value), first.value.modelId, 'act')
        return ok(undefined)
      }

      const toolResults = await runToolCalls(env, first.value.toolCalls)
      const second = await env.callModel({
        messages: withToolResults(env.contextMessages, textOf(first.value), toolResults),
        purpose: '汇总工具结果',
        ...(env.stepModelOverride === undefined ? {} : { modelOverride: env.stepModelOverride }),
      })
      if (!second.ok) return second
      await emitMessage(env, textOf(second.value), second.value.modelId, 'act')
      return ok(undefined)
    },
  }
}

/** reflective：初稿 → 自查 → 修订 */
export function createReflectiveStrategy(): AgentLoopStrategy {
  return {
    name: 'reflective',
    description: '生成初稿 → 自查（critique）→ 修订；maxIterations 控制轮数',
    async run(env: LoopRunEnv): Promise<Result<void>> {
      const draft = await env.callModel({ messages: env.contextMessages, tools: env.toolSchemas, purpose: '生成初稿' })
      if (!draft.ok) return draft

      let currentDraft = textOf(draft.value)
      if (draft.value.toolCalls.length > 0) {
        const toolResults = await runToolCalls(env, draft.value.toolCalls)
        const afterTools = await env.callModel({
          messages: withToolResults(env.contextMessages, currentDraft, toolResults),
          purpose: '结合工具结果生成初稿',
        })
        if (!afterTools.ok) return afterTools
        currentDraft = textOf(afterTools.value)
      }

      const rounds = Math.max(1, Math.min(env.maxIterations, 2))
      for (let round = 1; round <= rounds; round += 1) {
        if (env.shouldInterrupt()) return ok(undefined)
        const critique = await env.callModel({
          messages: [
            ...env.contextMessages,
            { role: 'assistant', content: currentDraft },
            {
              role: 'user',
              content: `请以严格评审者的身份检查上面的答复（第 ${round} 轮）：指出事实错误、遗漏与不清之处，只列问题，不要重写。`,
            },
          ],
          purpose: `自查（第 ${round} 轮）`,
        })
        if (!critique.ok) return critique
        await emitThought(env, `【自查第 ${round} 轮】\n${textOf(critique.value)}`)

        const revised = await env.callModel({
          messages: [
            ...env.contextMessages,
            { role: 'assistant', content: currentDraft },
            { role: 'user', content: `自查意见：\n${textOf(critique.value)}\n\n请据此给出修订后的最终答复。` },
          ],
          purpose: `修订（第 ${round} 轮）`,
        })
        if (!revised.ok) return revised
        currentDraft = textOf(revised.value)
      }

      await emitMessage(env, currentDraft, null, 'critique')
      return ok(undefined)
    },
  }
}

interface PlanStep {
  readonly step: number
  readonly title: string
  readonly detail?: string
}

function parsePlan(text: string, fallbackTitle: string): readonly PlanStep[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      const steps = (parsed as { steps?: unknown }).steps
      if (Array.isArray(steps)) {
        const normalized = steps
          .map((item, index) => {
            if (typeof item === 'string') return { step: index + 1, title: item }
            if (typeof item === 'object' && item !== null) {
              const record = item as Record<string, unknown>
              const title = typeof record['title'] === 'string' ? record['title'] : `步骤 ${index + 1}`
              const detail = typeof record['detail'] === 'string' ? record['detail'] : undefined
              return { step: index + 1, title, ...(detail === undefined ? {} : { detail }) }
            }
            return null
          })
          .filter((item): item is PlanStep => item !== null)
        if (normalized.length > 0) return normalized
      }
    } catch {
      // 落到兜底单步
    }
  }
  return [{ step: 1, title: fallbackTitle }]
}

/** plan-execute：结构化计划 → 逐步执行 → 阶段小结 */
export function createPlanExecuteStrategy(): AgentLoopStrategy {
  return {
    name: 'plan-execute',
    description: '让模型产出结构化计划并逐步执行（maxIterations 限步数、toolBudget 限工具调用）',
    async run(env: LoopRunEnv): Promise<Result<void>> {
      const planCall = await env.callModel({
        messages: [
          ...env.contextMessages,
          {
            role: 'user',
            content:
              '请先给出执行计划：只输出 JSON，格式 {"steps":[{"title":"…","detail":"…"}]}，不要任何解释文字。' +
              (env.stepModelOverride === undefined ? '' : `（本步骤指定模型：${env.stepModelOverride}）`),
          },
        ],
        purpose: '制定计划',
      })
      if (!planCall.ok) return planCall

      const steps = parsePlan(textOf(planCall.value), `完成：${env.userText.slice(0, 60)}`)
      const limited = steps.slice(0, Math.max(1, env.maxIterations))
      const planId = `plan_${env.turn}_${Date.now().toString(36)}`
      await env.emit({
        kind: 'plan',
        turn: env.turn,
        payload: {
          planId,
          steps: limited.map((step) => ({ step: step.step, title: step.title })),
          stepIndex: 0,
          status: 'running',
        },
      })

      const stepSummaries: string[] = []
      for (const [index, step] of limited.entries()) {
        if (env.shouldInterrupt()) {
          await env.emit({
            kind: 'plan',
            turn: env.turn,
            payload: { planId, steps: limited.map((item) => ({ step: item.step, title: item.title })), stepIndex: index, status: 'interrupted' },
          })
          return ok(undefined)
        }

        const stepMessages: readonly ChatMessage[] = [
          ...env.contextMessages,
          { role: 'user', content: `执行计划第 ${step.step} 步：${step.title}${step.detail === undefined ? '' : `（${step.detail}）`}。需要工具就调用工具，完成后给出本步骤结论。` },
        ]
        const stepCall = await env.callModel({ messages: stepMessages, tools: env.toolSchemas, purpose: `执行第 ${step.step} 步` })
        if (!stepCall.ok) return stepCall

        let stepText = textOf(stepCall.value)
        if (stepCall.value.toolCalls.length > 0) {
          const toolResults = await runToolCalls(env, stepCall.value.toolCalls)
          const afterTools = await env.callModel({
            messages: withToolResults(stepMessages, stepText, toolResults),
            purpose: `第 ${step.step} 步结论`,
          })
          if (!afterTools.ok) return afterTools
          stepText = textOf(afterTools.value)
        }
        stepSummaries.push(`第 ${step.step} 步「${step.title}」：${stepText}`)
        await env.emit({
          kind: 'plan',
          turn: env.turn,
          payload: {
            planId,
            steps: limited.map((item) => ({ step: item.step, title: item.title })),
            stepIndex: index + 1,
            status: index + 1 >= limited.length ? 'done' : 'running',
          },
        })
      }

      await emitMessage(env, stepSummaries.join('\n\n'), null, 'plan-execute')
      return ok(undefined)
    },
  }
}

export function registerBuiltinLoops(registry: {
  register(strategy: AgentLoopStrategy): void
}): void {
  for (const strategy of [createDirectStrategy(), createReflectiveStrategy(), createPlanExecuteStrategy()]) {
    registry.register(strategy)
  }
}
