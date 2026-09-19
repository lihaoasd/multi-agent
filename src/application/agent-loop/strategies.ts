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

async function emitThought(env: LoopRunEnv, text: string, purpose?: string): Promise<void> {
  if (text.trim().length === 0) return
  // S43/D46：带上"这一步是干什么的"（制定计划 / 执行第 N 步 / 汇总工具结果…）——
  // plan-execute 每步之间只隔一个在会话流里不显示的 `plan` 事件，不标来源就会显示成"两条连着、看不出差别的思考"
  await env.emit({
    kind: 'thought',
    turn: env.turn,
    payload: { text, ...(purpose === undefined || purpose.length === 0 ? {} : { purpose }) },
  })
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

function withToolResults(
  messages: readonly ChatMessage[],
  draft: string,
  toolResults: readonly string[],
  reasoning?: string,
): readonly ChatMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: draft.length > 0 ? draft : '（我先调用工具获取信息）',
      // S40/D43：思考内容随 assistant 消息回传——DeepSeek 在**带 tools** 的思考模式下，
      // 后续请求不回传 `reasoning_content` 会直接 400；适配器按模型条目的「思考」能力决定是否真的发出
      ...(reasoning === undefined || reasoning.length === 0 ? {} : { reasoning }),
    },
    { role: 'user', content: `工具执行结果如下，请据此给出最终答复：\n\n${toolResults.join('\n\n')}` },
  ]
}

/** 单轮里"调用工具 → 回注结果 → 再问"的最大轮数（防止模型无限要工具；工具预算另有上限） */
const MAX_TOOL_ROUNDS = 4

/**
 * 「模型 → 工具 → 回注 → 再问」的**有上限循环**（S30 根因修复）。
 *
 * ⚠️ 原实现只在第一轮传 `tools`，拿到工具结果后的追问**没带 tools**。后果有两个：
 * ① 模型在这一轮想再调工具时**永远调不到**（"先读再写"这类链条断掉）；
 * ② 模型仍想调用工具却无通道，只能把它"写"进正文——DeepSeek 的原生写法就是 DSML 文本，
 *    于是脏标记落进会话，而那一次调用从未执行（用户看到 `<||DSML|| invoke name="ask_user">` 就是这个）。
 *
 * 现在：每一轮都带同一批 `toolSchemas`；模型不再要工具、或工具预算用尽即停止（用尽时明确告知
 * 模型"本轮不能再调用工具，请直接给结论"，避免它再次改用文本方言）。
 */
async function runToolLoop(
  env: LoopRunEnv,
  input: { readonly messages: readonly ChatMessage[]; readonly purpose: string; readonly modelOverride?: string },
): Promise<Result<{ readonly text: string; readonly modelId: string | null }>> {
  let messages = input.messages
  let text = ''
  let modelId: string | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (env.shouldInterrupt()) break
    const exhausted = env.budget.used() >= env.toolBudget
    const request = {
      messages: exhausted
        ? [
            ...messages,
            {
              role: 'user' as const,
              content: `（工具预算 ${env.toolBudget} 已用尽，本轮不能再调用工具；需要我决策就请用自然语言说明，不要输出任何工具协议标记。）`,
            },
          ]
        : messages,
      // 关键：**每一轮都带 tools**（含"拿到结果后的追问"），模型才不会退化成文本协议
      ...(exhausted ? {} : { tools: env.toolSchemas }),
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      purpose: round === 0 ? input.purpose : `${input.purpose}（工具后续第 ${round} 轮）`,
    }
    const called = await env.callModel(request)
    if (!called.ok) return called
    // S40/D43：**每一轮**的思考都落进会话（原先只有 direct 的首次调用落地 → 页面看不到思考）
    await emitThought(env, called.value.reasoning, request.purpose)
    text = textOf(called.value)
    modelId = called.value.modelId
    if (called.value.toolCalls.length === 0) return ok({ text, modelId })
    const toolResults = await runToolCalls(env, called.value.toolCalls)
    messages = withToolResults(messages, text, toolResults, called.value.reasoning)
  }

  return ok({ text, modelId })
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
      await emitThought(env, first.value.reasoning, '直接回答')

      if (first.value.toolCalls.length === 0) {
        await emitMessage(env, textOf(first.value), first.value.modelId, 'act')
        return ok(undefined)
      }

      const toolResults = await runToolCalls(env, first.value.toolCalls)
      const concluded = await runToolLoop(env, {
        messages: withToolResults(env.contextMessages, textOf(first.value), toolResults, first.value.reasoning),
        purpose: '汇总工具结果',
        ...(env.stepModelOverride === undefined ? {} : { modelOverride: env.stepModelOverride }),
      })
      if (!concluded.ok) return concluded
      await emitMessage(env, concluded.value.text, concluded.value.modelId, 'act')
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
      await emitThought(env, draft.value.reasoning, '生成初稿')

      let currentDraft = textOf(draft.value)
      if (draft.value.toolCalls.length > 0) {
        const toolResults = await runToolCalls(env, draft.value.toolCalls)
        const afterTools = await runToolLoop(env, {
          messages: withToolResults(env.contextMessages, currentDraft, toolResults, draft.value.reasoning),
          purpose: '结合工具结果生成初稿',
        })
        if (!afterTools.ok) return afterTools
        currentDraft = afterTools.value.text
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
        // 自查这一轮的产出本身就是一条 `thought`（见下）；模型对这次自查的思考并入同一条，
        // 避免同一轮出现两条"看不出差别"的思考（S43/D46）
        await emitThought(env, `【自查第 ${round} 轮】\n${textOf(critique.value)}`, `自查（第 ${round} 轮）`)

        const revised = await env.callModel({
          messages: [
            ...env.contextMessages,
            { role: 'assistant', content: currentDraft },
            { role: 'user', content: `自查意见：\n${textOf(critique.value)}\n\n请据此给出修订后的最终答复。` },
          ],
          purpose: `修订（第 ${round} 轮）`,
        })
        if (!revised.ok) return revised
        await emitThought(env, revised.value.reasoning, `修订（第 ${round} 轮）`)
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
      // S40/D43：制定计划这一步的思考也要落进会话（S43/D46：标上来源，便于区分后面的各步思考）
      await emitThought(env, planCall.value.reasoning, '制定计划')

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
        // S40/D43：每一步的思考都落进会话（plan-execute 是内置模板默认策略，原先一条思考都没有）
        await emitThought(env, stepCall.value.reasoning, `执行第 ${step.step} 步`)

        let stepText = textOf(stepCall.value)
        if (stepCall.value.toolCalls.length > 0) {
          const toolResults = await runToolCalls(env, stepCall.value.toolCalls)
          const afterTools = await runToolLoop(env, {
            messages: withToolResults(stepMessages, stepText, toolResults, stepCall.value.reasoning),
            purpose: `第 ${step.step} 步结论`,
          })
          if (!afterTools.ok) return afterTools
          stepText = afterTools.value.text
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
