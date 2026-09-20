import { describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from '../../../src/application/tools/tool-executor'
import { taskClaimTool, taskUpdateTool } from '../../../src/infra/tools/builtin/task'
import type { TaskListFilter, TaskRecord, TaskService } from '../../../src/ports/task'
import { err, ok } from '../../../src/shared/result'

/**
 * S53 任务工具口径：
 * - ③ 任务没有「受阻」状态（`task_update` 拒绝 blocked，指路 done/terminated）；
 * - ② 汇报/领取的结果里要带出**名下剩余任务**，推着角色主动续领（"不能只等唤醒"）。
 */

const PROJECT = 'p_1'
const DEV = 'dev_1'

function record(overrides: Partial<TaskRecord> & { id: string; title: string; state: TaskRecord['state'] }): TaskRecord {
  return {
    desc: '',
    creator: 'user',
    assignee: DEV,
    sessionId: `u_${DEV}`,
    artifactIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    note: null,
    ...overrides,
  }
}

/** 内存版 TaskService：只实现任务工具用到的那部分语义 */
function fakeTasks(items: readonly TaskRecord[], options: { readonly failList?: boolean } = {}): TaskService {
  const all: TaskRecord[] = [...items]
  const match = (task: TaskRecord, filter?: TaskListFilter): boolean =>
    (filter?.state === undefined || task.state === filter.state) &&
    (filter?.assignee === undefined || task.assignee === filter.assignee)

  return {
    async create() {
      return err('ERR_INTERNAL', '测试未使用 create')
    },
    async claim(_projectId, taskId) {
      const index = all.findIndex((task) => task.id === taskId)
      if (index < 0) return err('ERR_NOT_FOUND', `任务不存在：${taskId}`)
      const next: TaskRecord = { ...all[index] as TaskRecord, state: 'in_progress' }
      all[index] = next
      return ok(next)
    },
    async setState(_projectId, taskId, state, runOptions) {
      const index = all.findIndex((task) => task.id === taskId)
      if (index < 0) return err('ERR_NOT_FOUND', `任务不存在：${taskId}`)
      const next: TaskRecord = {
        ...all[index] as TaskRecord,
        state,
        note: runOptions?.note ?? (all[index] as TaskRecord).note,
      }
      all[index] = next
      return ok(next)
    },
    async list(_projectId, filter) {
      if (options.failList === true) return err('ERR_INTERNAL', '读任务失败')
      return ok(all.filter((task) => match(task, filter)))
    },
    async get(_projectId, taskId) {
      const found = all.find((task) => task.id === taskId)
      return found === undefined ? err('ERR_NOT_FOUND', `任务不存在：${taskId}`) : ok(found)
    },
    async activeFor() {
      return ok(null)
    },
    async delegatedFor() {
      return ok([])
    },
  }
}

function contextOf(): ToolExecutionContext {
  return {
    projectId: PROJECT,
    instanceId: DEV,
    sessionId: `u_${DEV}`,
    sessionType: 'user',
    turn: 1,
    roots: { workdir: process.cwd(), runtime: process.cwd(), readonly: [] },
    projectPolicy: { highRiskCommands: true, docSubmitApproval: true, codeSubmitApproval: false, network: 'online' },
    signal: new AbortController().signal,
    requestApproval: async () => ok({ decision: 'approved' as const, approvalId: null }),
  }
}

describe('infra/tools/builtin/task · task_update（S53/D57）', () => {
  it('拒绝 blocked：任务没有「受阻」状态，并指出该怎么走', async () => {
    const tool = taskUpdateTool({ tasks: fakeTasks([record({ id: 't_1', title: '接入测试环境', state: 'in_progress' })]) })
    const outcome = await tool.handler({ taskId: 't_1', state: 'blocked', note: '缺环境' }, contextOf())
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('受阻')
    expect(outcome.text).toContain('terminated')
    expect(outcome).toMatchObject({ errorCode: 'ERR_VALIDATION' })
  })

  it('参数里的状态枚举只暴露 done/terminated', () => {
    const tool = taskUpdateTool({ tasks: fakeTasks([]) })
    const state = tool.definition.paramsSchema['properties'] as Record<string, { enum?: readonly string[] }>
    expect(state['state']?.enum).toEqual(['done', 'terminated'])
  })

  it('汇报 done 后带出名下剩余任务，要求继续领取而不是等唤醒', async () => {
    const tool = taskUpdateTool({
      tasks: fakeTasks([
        record({ id: 't_1', title: '登录模块', state: 'in_progress' }),
        record({ id: 't_2', title: '补测试', state: 'todo' }),
        record({ id: 't_3', title: '别人的活', state: 'todo', assignee: 'qa_1' }),
      ]),
    })
    const outcome = await tool.handler({ taskId: 't_1', state: 'done', note: '已实现' }, contextOf())
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('已汇报任务 t_1 → done')
    expect(outcome.text).toContain('还有 1 条未完成任务')
    expect(outcome.text).toContain('t_2')
    expect(outcome.text).not.toContain('t_3')
    expect(outcome.text).toContain('task_claim')
    expect(outcome.text).toContain('不要等唤醒')
  })

  it('名下已清空时明确说没有活，不再催领取', async () => {
    const tool = taskUpdateTool({ tasks: fakeTasks([record({ id: 't_1', title: '登录模块', state: 'in_progress' })]) })
    const outcome = await tool.handler({ taskId: 't_1', state: 'done' }, contextOf())
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('你名下已没有未完成任务')
  })

  it('读任务列表失败不影响汇报本身（提醒只是附加信息）', async () => {
    const tool = taskUpdateTool({
      tasks: fakeTasks([record({ id: 't_1', title: '登录模块', state: 'in_progress' })], { failList: true }),
    })
    const outcome = await tool.handler({ taskId: 't_1', state: 'terminated', note: '需求取消' }, contextOf())
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toBe('已汇报任务 t_1 → terminated')
  })
})

describe('infra/tools/builtin/task · task_claim（S53/D57）', () => {
  it('领取成功后提示名下还有几条待领取任务', async () => {
    const tool = taskClaimTool({
      tasks: fakeTasks([
        record({ id: 't_1', title: '登录模块', state: 'todo' }),
        record({ id: 't_2', title: '补测试', state: 'todo' }),
      ]),
    })
    const outcome = await tool.handler({ taskId: 't_1' }, contextOf())
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('已领取任务')
    expect(outcome.text).toContain('还有 1 条待领取任务')
    expect(outcome.text).toContain('t_2')
    expect(outcome.text).toContain('不要等唤醒')
  })

  it('名下只有这一条时不追加提醒', async () => {
    const tool = taskClaimTool({ tasks: fakeTasks([record({ id: 't_1', title: '登录模块', state: 'todo' })]) })
    const outcome = await tool.handler({ taskId: 't_1' }, contextOf())
    expect(outcome.ok).toBe(true)
    expect(outcome.text).not.toContain('待领取任务')
  })
})
