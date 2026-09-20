import { describe, expect, it } from 'vitest'
import type { TaskState } from '../../../web/src/api/work'
import { holdingTaskOf, SELECTABLE_TASK_STATES, taskStateOptions } from '../../../web/src/lib/task-state'

const LABELS: Record<TaskState, string> = {
  todo: '待领取',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻（旧数据）',
  terminated: '已终止',
}

/**
 * 用户报告："任务与产出物里任务状态是不能修改的"。
 * 下拉至少要做到：不提供「受阻」（S53）、不提供"当前状态"（选了只会报错）、历史状态显示中文名。
 */
describe('web/lib/task-state · 任务状态下拉（S55/D59）', () => {
  it('不提供「受阻」', () => {
    expect(SELECTABLE_TASK_STATES).toEqual(['todo', 'in_progress', 'done', 'terminated'])
    const values = taskStateOptions('todo', LABELS).map((option) => option.value)
    expect(values).not.toContain('blocked')
  })

  it('排除当前状态：不会再点出「任务已是 X 状态」', () => {
    for (const current of SELECTABLE_TASK_STATES) {
      const options = taskStateOptions(current, LABELS)
      expect(options.map((option) => option.value)).not.toContain(current)
      expect(options).toHaveLength(SELECTABLE_TASK_STATES.length - 1)
      expect(options.every((option) => !option.disabled)).toBe(true)
    }
  })

  it('当前状态是历史值（blocked）时补一条禁用占位项，显示中文名而不是原始值', () => {
    const options = taskStateOptions('blocked', LABELS)
    expect(options[0]).toEqual({ value: 'blocked', label: '受阻（旧数据）', disabled: true })
    expect(options.slice(1).map((option) => option.value)).toEqual([...SELECTABLE_TASK_STATES])
    expect(options.slice(1).every((option) => !option.disabled)).toBe(true)
  })

  it('holdingTaskOf：取"占着单工槽位"的那条任务；缺字段返回 null', () => {
    expect(holdingTaskOf({ holding: 't_1', holdingTitle: '正在做的活' })).toEqual({ id: 't_1', title: '正在做的活' })
    // 只有 id 时用 id 兜底当标题
    expect(holdingTaskOf({ holding: 't_1' })).toEqual({ id: 't_1', title: 't_1' })
    expect(holdingTaskOf({})).toBeNull()
    expect(holdingTaskOf({ holding: '' })).toBeNull()
    expect(holdingTaskOf({ holding: 42 })).toBeNull()
    expect(holdingTaskOf(undefined)).toBeNull()
  })
})
