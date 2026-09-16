import { describe, expect, it, vi } from 'vitest'
import {
  createDirectStrategy,
  createPlanExecuteStrategy,
  createReflectiveStrategy,
} from '../../../src/application/agent-loop/strategies'
import type { LoopRunEnv, ModelTurnResult } from '../../../src/application/agent-loop/loop'
import type { NewEvent, StoredEvent } from '../../../src/ports/session'
import { ok, type Result } from '../../../src/shared/result'

interface Harness {
  readonly env: LoopRunEnv
  readonly events: NewEvent[]
  readonly toolCalls: { name: string; args: unknown }[]
  readonly modelCalls: string[]
}

function harness(replies: readonly Partial<ModelTurnResult>[]): Harness {
  const events: NewEvent[] = []
  const toolCalls: { name: string; args: unknown }[] = []
  const modelCalls: string[] = []
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

  return { env, events, toolCalls, modelCalls }
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
  })
})

describe('application/agent-loop · reflective 策略', () => {
  it('初稿 → 自查 → 修订，并保留自查思考事件', async () => {
    const h = harness([{ text: '初稿内容' }, { reasoning: '发现问题', text: '这里不严谨' }, { text: '修订后的最终稿' }])
    const result = await createReflectiveStrategy().run({ ...h.env, maxIterations: 1 })
    expect(result.ok).toBe(true)
    expect(h.modelCalls).toEqual(['生成初稿', '自查（第 1 轮）', '修订（第 1 轮）'])
    expect(h.events.filter((event) => event.kind === 'thought')).toHaveLength(1)
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

  it('计划不是合法 JSON 时退化为单步计划（不失败）', async () => {
    const h = harness([{ text: '我先看看代码' }, { text: '完成' }])
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
})

describe('application/agent-loop · 工具预算', () => {
  it('toolBudget 用尽后不再执行工具（事件里明确说明）', async () => {
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
