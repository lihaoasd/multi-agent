import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createToolExecutor } from '../../../src/application/tools/tool-executor'
import { createPolicyEngine } from '../../../src/domain/rules/policy'
import { createToolRegistry } from '../../../src/infra/tools/registry'
import type { PathRoots } from '../../../src/ports/path-resolver'
import type { ProjectPolicy } from '../../../src/ports/policy'
import type { ToolDefinition } from '../../../src/ports/tools'
import type { ToolExecutionContext } from '../../../src/application/tools/tool-executor'

const roots: PathRoots = {
  workdir: mkdtempSync(join(tmpdir(), 'ah-exec-')),
  runtime: mkdtempSync(join(tmpdir(), 'ah-exec-rt-')),
  readonly: [],
}

const onlinePolicy: ProjectPolicy = {
  highRiskCommands: true,
  docSubmitApproval: true,
  codeSubmitApproval: false,
  network: 'online',
}

function definitionOf(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'demo_tool',
    package: 'fs',
    description: '演示工具',
    paramsSchema: { type: 'object', properties: {}, required: [] },
    scope: 'platform',
    risk: 'none',
    network: 'none',
    idempotent: true,
    availableIn: ['user'],
    allowedRoots: [],
    output: { maxChars: 100, strategy: 'truncate-tail' },
    ...overrides,
  }
}

function contextOf(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    projectId: 'p_1',
    instanceId: 'dev_1',
    sessionId: 'u_dev_1',
    sessionType: 'user',
    turn: 1,
    roots,
    projectPolicy: onlinePolicy,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => ({ ok: true as const, value: { decision: 'approved' as const, approvalId: 'ap_1' } })),
    ...overrides,
  }
}

describe('application/tools/tool-executor · 校验链（规则 3）', () => {
  it('未注册工具被拒绝（不执行任何处理函数）', async () => {
    const registry = createToolRegistry()
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })
    const result = await executor.execute({ callId: 'c1', name: 'ghost', args: {} }, contextOf())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ERR_TOOL_REJECTED')
  })

  it('会话类型不适用 → 拒绝', async () => {
    const registry = createToolRegistry()
    const handler = vi.fn(async () => ({ ok: true, text: 'done' }))
    registry.register(definitionOf({ availableIn: [] }), handler)
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })
    const result = await executor.execute({ callId: 'c1', name: 'demo_tool', args: {} }, contextOf())
    expect(result.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('策略 allow → 直接执行；输出按 output.maxChars 兜底截断', async () => {
    const registry = createToolRegistry()
    registry.register(definitionOf({ output: { maxChars: 20, strategy: 'truncate-tail' } }), async () => ({
      ok: true,
      text: 'x'.repeat(100),
    }))
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })
    const result = await executor.execute({ callId: 'c1', name: 'demo_tool', args: {} }, contextOf())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.text).toContain('输出已截断')
      expect(result.value.text.length).toBeLessThan(60)
    }
  })

  it('策略 deny → 拒绝且不执行（离线联网工具）', async () => {
    const registry = createToolRegistry()
    const handler = vi.fn(async () => ({ ok: true, text: 'should not run' }))
    registry.register(definitionOf({ network: 'allowed' }), handler)
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })
    const result = await executor.execute(
      { callId: 'c1', name: 'demo_tool', args: {} },
      contextOf({ projectPolicy: { ...onlinePolicy, network: 'offline' } }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ERR_NET_OFFLINE')
    expect(handler).not.toHaveBeenCalled()
  })

  it('策略 approval：用户同意才执行；拒绝则回注 ERR_APPROVAL_REJECTED', async () => {
    const registry = createToolRegistry()
    const handler = vi.fn(async () => ({ ok: true, text: 'executed' }))
    registry.register(definitionOf({ risk: 'high' }), handler)
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })

    const approved = await executor.execute({ callId: 'c1', name: 'demo_tool', args: {} }, contextOf())
    expect(approved.ok).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)

    handler.mockClear()
    const rejected = await executor.execute(
      { callId: 'c2', name: 'demo_tool', args: {} },
      contextOf({ requestApproval: vi.fn(async () => ({ ok: true as const, value: { decision: 'rejected' as const, approvalId: 'ap_2' } })) }),
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('ERR_APPROVAL_REJECTED')
    expect(handler).not.toHaveBeenCalled()
  })

  it('policyAction 返回 null（参数非法）→ ERR_VALIDATION', async () => {
    const registry = createToolRegistry()
    registry.register(definitionOf({ policyAction: () => null }), async () => ({ ok: true, text: 'x' }))
    const executor = createToolExecutor({ registry, policy: createPolicyEngine() })
    const result = await executor.execute({ callId: 'c1', name: 'demo_tool', args: {} }, contextOf())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ERR_VALIDATION')
  })
})
