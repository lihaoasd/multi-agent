import { describe, expect, it } from 'vitest'
import {
  describeInstanceOverrides,
  resolveEffectiveAgentConfig,
} from '../../../src/application/team/effective-config'
import type { RoleInstance } from '../../../src/ports/project'

function instance(overrides: Partial<RoleInstance> = {}): RoleInstance {
  return {
    instanceId: 'dev_1',
    roleTemplateId: 'dev',
    displayName: '高级开发',
    prompt: null,
    model: null,
    loop: null,
    enabled: true,
    configVersion: 1,
    createdAt: '2026-09-15T00:00:00.000Z',
    snapshot: {
      roleTemplateId: 'dev',
      templateName: '高级开发',
      systemPrompt: '模板提示词',
      defaultModel: 'snapshot-model',
      defaultLoop: { strategy: 'plan-execute', params: { maxIterations: 8 } },
      packages: ['fs', 'cmd'],
      tools: ['fs_read_file'],
      artifactTypes: ['code'],
      defaultApprovalRules: [],
      capturedAt: '2026-09-15T00:00:00.000Z',
    },
    ...overrides,
  }
}

describe('application/team/effective-config（D20-⑦ 解析链；S14 起两级）', () => {
  it('无覆盖时用模板快照', () => {
    const effective = resolveEffectiveAgentConfig(instance())
    expect(effective.systemPrompt).toBe('模板提示词')
    expect(effective.model).toBe('snapshot-model')
    expect(effective.loop.strategy).toBe('plan-execute')
    expect(effective.tools).toEqual(['fs_read_file'])
  })

  it('实例覆盖优先于快照（提示词整段替换）', () => {
    const effective = resolveEffectiveAgentConfig(
      instance({
        prompt: '实例提示词',
        model: 'override-model',
        loop: { strategy: 'direct', params: {} },
      }),
    )
    expect(effective.systemPrompt).toBe('实例提示词')
    expect(effective.model).toBe('override-model')
    expect(effective.loop).toEqual({ strategy: 'direct', params: {} })
  })

  it('两级都没有模型则为 null（S14：不再有平台默认这一级，不静默挑模型）', () => {
    const noSnapshotModel = instance({
      snapshot: { ...instance().snapshot, defaultModel: null },
    })
    expect(resolveEffectiveAgentConfig(noSnapshotModel).model).toBeNull()
  })

  it('describeInstanceOverrides 只列出被显式覆盖的字段', () => {
    expect(describeInstanceOverrides(instance())).toEqual([])
    expect(describeInstanceOverrides(instance({ prompt: 'x' }))).toEqual(['prompt'])
    expect(describeInstanceOverrides(instance({ model: 'm', loop: { strategy: 'direct', params: {} } }))).toEqual([
      'model',
      'loop',
    ])
  })
})
