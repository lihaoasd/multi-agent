import { describe, expect, it, vi } from 'vitest'
import {
  createDirectStrategy,
  createPlanExecuteStrategy,
  createReflectiveStrategy,
} from '../../../src/application/agent-loop/strategies'
import type { LoopRunEnv, ModelTurnResult } from '../../../src/application/agent-loop/loop'
import type { ChatMessage } from '../../../src/ports/model'
import type { NewEvent, StoredEvent } from '../../../src/ports/session'
import { ok, type Result } from '../../../src/shared/result'

interface Harness {
  readonly env: LoopRunEnv
  readonly events: NewEvent[]
  readonly toolCalls: { name: string; args: unknown }[]
  readonly modelCalls: string[]
  /** 每次模型调用时请求里带的 tool schema 数量（S30 回归用：0 = 没给模型工具通道） */
  readonly callToolSchemaCounts: number[]
  /** 每次模型调用的请求（S40：断言思考随 assistant 消息回传） */
  readonly requests: { purpose: string; messages: readonly ChatMessage[] }[]
}

function harness(replies: readonly Partial<ModelTurnResult>[]): Harness {
  const events: NewEvent[] = []
  const toolCalls: { name: string; args: unknown }[] = []
  const modelCalls: string[] = []
  const callToolSchemaCounts: number[] = []
  const requests: { purpose: string; messages: readonly ChatMessage[] }[] = []
  let index = 0

  const env: LoopRunEnv = {
    projectId: 'p_1',
    sessionId: 'u_dev_1',
    instanceId: 'dev_1',
    turn: 1,
    userText: '把登录模块拆一下',
    systemPrompt: '你是开发',
    contextMessages: [{ role: 'system', content: '你是开发' }, { role: 'user', content: '把登录模块拆一下' }],
    history: [],
    toolSchemas: [{ name: 'fs_read_file', description: '读文件', parameters: {} }],
    toolNames: ['fs_read_file'],
    maxIterations: 3,
    toolBudget: 5,
    signal: new AbortController().signal,
    emit: async (event): Promise<Result<StoredEvent>> => {
      events.push(event)
      return ok({ seq: events.length, ts: '2026-09-15T00:00:00.000Z', sessionId: 'u_dev_1', turn: event.turn, kind: event.kind, payload: event.payload })
    },
    notify: () => undefined,
    callModel: async (request): Promise<Result<ModelTurnResult>> => {
      modelCalls.push(request.purpose)
      callToolSchemaCounts.push(request.tools?.length ?? 0)
      requests.push({ purpose: request.purpose, messages: request.messages })
      const reply = replies[Math.min(index, replies.length - 1)] ?? {}
      index += 1
      return ok({
        text: reply.text ?? '',
        reasoning: reply.reasoning ?? '',
        toolCalls: reply.toolCalls ?? [],
        modelId: 'test-model',
      })
    },
    runTool: async (call): Promise<Result<{ ok: boolean; text: string }>> => {
      toolCalls.push({ name: call.name, args: call.args })
      return ok({ ok: true, text: '文件内容：export const login = 1' })
    },
    budget: {
      used: () => toolCalls.length,
      spend: () => undefined,
    },
    shouldInterrupt: () => false,
  }

  return { env, events, toolCalls, modelCalls, callToolSchemaCounts, requests }
}

describe('application/agent-loop · direct 策略', () => {
  it('无工具调用：一次模型调用 → 一条 agent message', async () => {
    const h = harness([{ text: '直接回答' }])
    const result = await createDirectStrategy().run(h.env)
    expect(result.ok).toBe(true)
    expect(h.modelCalls).toEqual(['直接回答'])
    expect(h.events.map((event) => event.kind)).toEqual(['message'])
    expect(h.events[0]?.payload['text']).toBe('直接回答')
  })

  it('有工具调用：执行工具（写 tool_call/tool_result）后再汇总一次', async () => {
    const h = harness([
      { text: '我先读文件', toolCalls: [{ callId: 'c1', name: 'fs_read_file', args: { path: 'workdir://index.ts' } }] },
      { text: '汇总结论' },
    ])
    const result = await createDirectStrategy().run(h.env)
    expect(result.ok).toBe(true)
    expect(h.toolCalls).toHaveLength(1)
    expect(h.events.map((event) => event.kind)).toEqual(['tool_call', 'tool_result', 'message'])
    expect(h.events[1]?.payload['ok']).toBe(true)
    expect(h.events.at(-1)?.payload['text']).toBe('汇总结论')
    // S30：汇总调用也必须带 tools（此前漏传 → 模型想再调工具时只能用文本协议写出来）
    expect(h.callToolSchemaCounts).toEqual([1, 1])
  })

  it('S40：每一轮的思考都落进会话，且随 assistant 消息回传（DeepSeek 带 tools 时硬要求）', async () => {
    const h = harness([
      { text: '我先读文件', reasoning: '先想想读哪个文件', toolCalls: [{ callId: 'c1', name: 'fs_read_file', args: {} }] },
      { text: '汇总结论', reasoning: '结果够了，可以下结论' },
    ])
    const result = await createDirectStrategy().run(h.env)
    expect(result.ok).toBe(true)
    // 两轮思考都落地（原先只有第一轮、且 plan-execute 一条都没有 → 页面看不到思考）
    expect(h.events.filter((event) => event.kind === 'thought').map((event) => event.payload['text'])).toEqual([
      '先想想读哪个文件',
      '结果够了，可以下结论',
    ])
    // 回传：第二轮请求里的 assistant 消息必须带着上一轮的 reasoning
    const assistant = h.requests[1]?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.reasoning).toBe('先想想读哪个文件')
  })
})

describe('application/agent-loop · reflective 策略', () => {
  it('初稿 → 自查 → 修订，并保留自查思考事件', async () => {
    const h = harness([{ text: '初稿内容' }, { reasoning: '发现问题', text: '这里不严谨' }, { text: '修订后的最终稿' }])
    const result = await createReflectiveStrategy().run({ ...h.env, maxIterations: 1 })
    expect(result.ok).toBe(true)
    expect(h.modelCalls).toEqual(['生成初稿', '自查（第 1 轮）', '修订（第 1 轮）'])
    // S43/D46：自查这一轮的产出本身是一条 `thought`（带上来源），模型对这次自查的思考并入同一条
    const thoughts = h.events.filter((event) => event.kind === 'thought')
    expect(thoughts.map((event) => event.payload['text'])).toEqual(['【自查第 1 轮】\n这里不严谨'])
    expect(thoughts.map((event) => event.payload['purpose'])).toEqual(['自查（第 1 轮）'])
    expect(h.events.at(-1)?.kind).toBe('message')
    expect(h.events.at(-1)?.payload['text']).toBe('修订后的最终稿')
  })
})

describe('application/agent-loop · plan-execute 策略', () => {
  it('计划由模型产出并落 plan 事件，逐步执行后汇总', async () => {
    const h = harness([
      { text: '{"steps":[{"title":"读代码","detail":"先看结构"},{"title":"写方案"}]}' },
      { text: '第 1 步完成' },
      { text: '第 2 步完成' },
    ])
    const result = await createPlanExecuteStrategy().run({ ...h.env, maxIterations: 2 })
    expect(result.ok).toBe(true)

    const plans = h.events.filter((event) => event.kind === 'plan')
    expect(plans.length).toBeGreaterThanOrEqual(3) // 初始 + 每步进度
    expect(plans[0]?.payload['steps']).toEqual([
      { step: 1, title: '读代码' },
      { step: 2, title: '写方案' },
    ])
    expect(plans.at(-1)?.payload['status']).toBe('done')
    expect(h.events.at(-1)?.kind).toBe('message')
    expect(String(h.events.at(-1)?.payload['text'])).toContain('第 2 步完成')
  })

  it('S40：制定计划与每一步的思考都落进会话（原先 plan-execute 一条思考都没有）', async () => {
    const h = harness([
      { reasoning: '先拆成两步', text: '{"steps":[{"title":"读代码"},{"title":"写方案"}]}' },
      { reasoning: '第一步先看结构', text: '第 1 步完成' },
      { reasoning: '第二步写方案', text: '第 2 步完成' },
    ])
    const result = await createPlanExecuteStrategy().run({ ...h.env, maxIterations: 2 })
    expect(result.ok).toBe(true)
    expect(h.events.filter((event) => event.kind === 'thought').map((event) => event.payload['text'])).toEqual([
      '先拆成两步',
      '第一步先看结构',
      '第二步写方案',
    ])
    // S43/D46：每条思考都标出"这一步是干什么的"——plan-execute 各步之间只隔一个不显示的 `plan` 事件
    expect(h.events.filter((event) => event.kind === 'thought').map((event) => event.payload['purpose'])).toEqual([
      '制定计划',
      '执行第 1 步',
      '执行第 2 步',
    ])
  })

  it('计划不是合法 JSON 时退化为单步计划（不失败）', async () => {    const h = harness([{ text: '我先看看代码' }, { text: '完成' }])
    const result = await createPlanExecuteStrategy().run({ ...h.env, maxIterations: 3 })
    expect(result.ok).toBe(true)
    const plans = h.events.filter((event) => event.kind === 'plan')
    expect(plans[0]?.payload['steps']).toHaveLength(1)
  })

  it('maxIterations 限制步数；中断时不继续执行', async () => {
    const h = harness([
      { text: '{"steps":[{"title":"a"},{"title":"b"},{"title":"c"}]}' },
      { text: 'a done' },
    ])
    const result = await createPlanExecuteStrategy().run({ ...h.env, maxIterations: 1 })
    expect(result.ok).toBe(true)
    const plans = h.events.filter((event) => event.kind === 'plan')
    expect(plans[0]?.payload['steps']).toHaveLength(1)
    expect(h.modelCalls).toHaveLength(2) // 计划 + 第 1 步
  })

  it('shouldInterrupt 为真时写出 interrupted 计划状态并结束', async () => {
    const h = harness([{ text: '{"steps":[{"title":"a"},{"title":"b"}]}' }])
    const result = await createPlanExecuteStrategy().run({
      ...h.env,
      maxIterations: 2,
      shouldInterrupt: () => true,
    })
    expect(result.ok).toBe(true)
    expect(h.events.some((event) => event.kind === 'plan' && event.payload['status'] === 'interrupted')).toBe(true)
  })

  it('S30 回归：步骤结论的追问**带 tools**，模型在追问里仍能继续调工具', async () => {
    const h = harness([
      // 1) 制定计划（无工具，正常）
      { text: '{"steps":[{"title":"读代码"}]}' },
      // 2) 第 1 步：先调一个工具
      { text: '先看目录', toolCalls: [{ callId: 'c1', name: 'fs_read_file', args: { path: 'workdir://' } }] },
      // 3) 拿到结果后的追问：**必须带 tools**，否则这一步再也调不到工具
      { text: '再看看任务', toolCalls: [{ callId: 'c2', name: 'fs_read_file', args: { path: 'workdir://src' } }] },
      // 4) 第二轮追问给出结论
      { text: '第 1 步结论：结构清晰' },
    ])
    const result = await createPlanExecuteStrategy().run({ ...h.env, maxIterations: 1 })
    expect(result.ok).toBe(true)

    // 计划调用不带工具；从第 1 步开始，**每一轮都带 tools**（含追问）
    expect(h.callToolSchemaCounts[0]).toBe(0)
    expect(h.callToolSchemaCounts.slice(1).every((count) => count === 1)).toBe(true)

    // 追问里发出的工具调用被真正执行（两次 tool_call 事件），而不是退化成文本
    const toolCallEvents = h.events.filter((event) => event.kind === 'tool_call')
    expect(toolCallEvents).toHaveLength(2)
    expect(h.toolCalls.map((call) => call.name)).toEqual(['fs_read_file', 'fs_read_file'])
    expect(String(h.events.at(-1)?.payload['text'])).toContain('第 1 步结论')
  })
})

describe('application/agent-loop · 工具预算', () => {  it('toolBudget 用尽后不再执行工具（事件里明确说明）', async () => {
    const h = harness([
      {
        text: '读两个文件',
        toolCalls: [
          { callId: 'c1', name: 'fs_read_file', args: { path: 'workdir://a.ts' } },
          { callId: 'c2', name: 'fs_read_file', args: { path: 'workdir://b.ts' } },
        ],
      },
      { text: '汇总' },
    ])
    const budgetSpy = vi.fn()
    const result = await createDirectStrategy().run({
      ...h.env,
      toolBudget: 1,
      budget: { used: () => h.toolCalls.length, spend: budgetSpy },
    })
    expect(result.ok).toBe(true)
    expect(h.toolCalls).toHaveLength(1)
    expect(h.events.filter((event) => event.kind === 'tool_call')).toHaveLength(1)
  })
})
