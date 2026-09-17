import { describe, expect, it } from 'vitest'
import {
  MAX_DELEGATED_TASKS_IN_PROMPT,
  buildAgentContext,
  delegatedTaskLine,
} from '../../../src/application/agent-loop/context-builder'
import type { EffectiveAgentConfig } from '../../../src/application/team/effective-config'
import type { TaskRecord } from '../../../src/ports/task'

/**
 * S36/D39：委派人的上下文要能看到"自己派出去的活干到哪了"，
 * 这样"接收到回报后继续执行"跨回合仍然成立（不依赖单条聊天消息）。
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

const task = (overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'assignee'>): TaskRecord => ({
  title: '实现登录模块',
  desc: '',
  creator: 'pm_1',
  state: 'todo',
  sessionId: `u_${overrides.assignee}`,
  artifactIds: [],
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:00:00.000Z',
  note: null,
  ...overrides,
})

const build = (delegatedTasks?: readonly TaskRecord[]) =>
  buildAgentContext({
    project: { id: 'p_1', name: '演示项目', workdir: 'D:/tmp/demo' },
    effective,
    history: [],
    toolSchemas: [],
    ...(delegatedTasks === undefined ? {} : { delegatedTasks }),
    limits: { rawWindow: 10, maxCharsPerMsg: 2_000, maxPromptChars: 20_000 },
  })

describe('S36 · 委派人上下文里的「我委派出去的任务」', () => {
  it('没有委派任务时不注入该块', () => {
    const blocks = build().blocks
    expect(blocks.find((block) => block.id === 'delegated-tasks')).toBeUndefined()
  })

  it('有委派任务时给出任务行、状态与备注，并要求据此继续', () => {
    const built = build([
      task({ id: 't_2', assignee: 'qa_1', title: '回归登录模块', state: 'in_progress' }),
      task({ id: 't_1', assignee: 'dev_1', state: 'done', note: '已实现并自测' }),
    ])
    const block = built.blocks.find((item) => item.id === 'delegated-tasks')
    expect(block).toBeDefined()
    expect(block?.title).toBe('我委派出去的任务')
    // origin 复用 task-context：系统提示词预览按 origin 展示，不新增前端标签
    expect(block?.origin).toBe('task-context')
    const lines = block?.text.split('\n') ?? []
    expect(lines[1]).toBe('- t_2 → qa_1：《回归登录模块》：in_progress')
    expect(lines[2]).toBe('- t_1 → dev_1：《实现登录模块》：done（已实现并自测）')
    expect(block?.text).toContain('请据此继续你自己的计划')
    // 块顺序：紧跟当前任务之后（有当前任务时），且在工具/产出物块之前
    expect(built.text).toContain('我委派出去的任务')
  })

  it('超过上限只列前 N 条并提示用 task_list 看全部', () => {
    const many = Array.from({ length: MAX_DELEGATED_TASKS_IN_PROMPT + 3 }, (_unused, index) =>
      task({ id: `t_${index}`, assignee: 'dev_1' }),
    )
    const block = build(many).blocks.find((item) => item.id === 'delegated-tasks')
    const lines = block?.text.split('\n') ?? []
    expect(lines.filter((line) => line.startsWith('- t_'))).toHaveLength(MAX_DELEGATED_TASKS_IN_PROMPT)
    expect(block?.text).toContain('（另有 3 条，需要时用 task_list 查看全部）')
  })

  it('delegatedTaskLine：无备注不留空括号', () => {
    expect(delegatedTaskLine(task({ id: 't_1', assignee: 'dev_1', state: 'blocked' }))).toBe(
      '- t_1 → dev_1：《实现登录模块》：blocked',
    )
    expect(delegatedTaskLine(task({ id: 't_1', assignee: 'dev_1', state: 'blocked', note: '缺字段' }))).toBe(
      '- t_1 → dev_1：《实现登录模块》：blocked（缺字段）',
    )
  })
})
