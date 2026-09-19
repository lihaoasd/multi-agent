import { describe, expect, it } from 'vitest'
import { buildAgentContext } from '../../../src/application/agent-loop/context-builder'
import type { EffectiveAgentConfig } from '../../../src/application/team/effective-config'
import type { TaskRecord } from '../../../src/ports/task'

/**
 * S50/D53：
 * -「团队与可委派对象」块：让派发人**按角色职能**决定派给谁（用户口径 1）；
 * -「待领取任务」块：每回合提醒受派人先 task_claim（用户口径 2 的根因——实测有任务创建后 7 小时没被领取）；
 * - 平台提示里的"文档放 `docs/`"约定（用户口径 3）。
 */
const effective: EffectiveAgentConfig = {
  instanceId: 'pm_1',
  roleTemplateId: 'pm',
  displayName: '项目经理',
  enabled: true,
  systemPrompt: '你是项目经理。',
  model: null,
  loop: { strategy: 'direct', params: {} },
  packages: ['fs'],
  tools: ['task_assign'],
  artifactTypes: ['doc'],
  approvalRules: [],
}

const task = (overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id'>): TaskRecord => ({
  title: '实现登录模块',
  desc: '',
  creator: 'pm_1',
  assignee: 'dev_1',
  state: 'todo',
  sessionId: 'u_dev_1',
  artifactIds: [],
  createdAt: '2026-09-19T10:00:00.000Z',
  updatedAt: '2026-09-19T10:00:00.000Z',
  note: null,
  ...overrides,
})

const build = (input: {
  readonly team?: Parameters<typeof buildAgentContext>[0]['team']
  readonly delegatesTo?: readonly string[]
  readonly pendingTasks?: readonly TaskRecord[]
}) =>
  buildAgentContext({
    project: { id: 'p_1', name: '演示项目', workdir: 'D:/tmp/demo' },
    effective,
    history: [],
    toolSchemas: [],
    ...input,
    limits: { rawWindow: 10, maxCharsPerMsg: 2_000, maxPromptChars: 20_000 },
  })

describe('S50 · 团队与可委派对象（按职能派单）', () => {
  it('列出成员职能，并给出我可以直接派单的对象', () => {
    const block = build({
      team: [
        { instanceId: 'pm_1', displayName: '项目经理', roleTemplateId: 'pm', duty: '统筹与派单' },
        { instanceId: 'dev_1', displayName: '高级开发', roleTemplateId: 'dev', duty: '编码实现与自测' },
        { instanceId: 'qa_1', displayName: '测试工程师', roleTemplateId: 'qa', enabled: false },
      ],
      delegatesTo: ['dev_1', 'qa_1'],
    }).blocks.find((item) => item.id === 'team-roster')
    expect(block).toBeDefined()
    expect(block?.origin).toBe('team-roster')
    expect(block?.text).toContain('- 高级开发 dev_1（dev）：编码实现与自测')
    expect(block?.text).toContain('（已停用）')
    expect(block?.text).toContain('你当前**可以直接派单**的对象（编排图出边）：dev_1、qa_1')
    expect(block?.text).toContain('task_assign')
  })

  it('没有出边时明确说"不能派单给他人"（附向老板求助的出口）', () => {
    const block = build({
      team: [{ instanceId: 'dev_1', displayName: '高级开发', roleTemplateId: 'dev' }],
    }).blocks.find((item) => item.id === 'team-roster')
    expect(block?.text).toContain('你**没有**可委派对象')
    expect(block?.text).toContain('ask_user')
  })

  it('没有团队成员信息时整个块不注入（不占版面）', () => {
    expect(build({}).blocks.find((item) => item.id === 'team-roster')).toBeUndefined()
  })
})

describe('S50 · 待领取任务（每回合提醒先领取）', () => {
  it('列出 todo 任务、发起人、说明与领取指引', () => {
    const block = build({
      pendingTasks: [task({ id: 't_1', desc: '按 §6 契约实现 game.js' })],
    }).blocks.find((item) => item.id === 'pending-tasks')
    expect(block).toBeDefined()
    expect(block?.origin).toBe('task-context')
    expect(block?.text).toContain('- t_1《实现登录模块》（发起：pm_1）')
    expect(block?.text).toContain('说明：按 §6 契约实现 game.js')
    expect(block?.text).toContain('用 task_claim 领取')
    expect(block?.text).toContain('你已有进行中的任务')
  })

  it('没有说明时不出现空的"说明："行', () => {
    const block = build({ pendingTasks: [task({ id: 't_1' })] }).blocks.find((item) => item.id === 'pending-tasks')
    expect(block?.text).not.toContain('说明：')
  })

  it('没有待领取任务时不注入', () => {
    expect(build({}).blocks.find((item) => item.id === 'pending-tasks')).toBeUndefined()
  })
})

describe('S50 · 文档产出统一放 docs/', () => {
  it('平台角色定位里写明 doc 产出物写到 workdir://docs/', () => {
    const block = build({}).blocks.find((item) => item.id === 'platform-role')
    expect(block?.text).toContain('`docs/`')
    expect(block?.text).toContain('workdir://docs/design.md')
  })
})
