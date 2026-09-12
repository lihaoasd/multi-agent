/**
 * 任务栏视图规则单测（web/task-board.js，纯函数）：
 * 右栏只显示活跃任务；面板固定三列（待领取 / 进行中 / 已结束）。
 */
import { describe, expect, it } from 'vitest'

import { activeTasks, groupBoardTasks, countByState, BOARD_COLUMNS } from '../web/task-board.js'

const t = (id, state, updatedAt = '2026-09-12T00:00:00.000Z') => ({
  id,
  title: id,
  state,
  assignee: 'dev_1',
  creator: 'pm_1',
  updatedAt,
})

describe('任务栏右栏：只显示进行中与待领取', () => {
  it('过滤掉已完成/受阻/已终止，且进行中排在待领取前面', () => {
    const list = activeTasks([
      t('a', 'done'),
      t('b', 'todo'),
      t('c', 'in_progress'),
      t('d', 'terminated'),
      t('e', 'blocked'),
      t('f', 'todo'),
    ])
    expect(list.map((x) => x.id)).toEqual(['c', 'b', 'f'])
  })

  it('同一状态内按更新时间倒序；空/缺省输入安全', () => {
    const list = activeTasks([
      t('old', 'todo', '2026-09-11T00:00:00.000Z'),
      t('new', 'todo', '2026-09-12T10:00:00.000Z'),
    ])
    expect(list.map((x) => x.id)).toEqual(['new', 'old'])
    expect(activeTasks(undefined)).toEqual([])
    expect(activeTasks([])).toEqual([])
  })
})

describe('任务栏面板：固定三列', () => {
  it('列定义就是三列（待领取 / 进行中 / 已结束）', () => {
    expect(BOARD_COLUMNS).toHaveLength(3)
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(['todo', 'in_progress', 'closed'])
  })

  it('分组把完成任务收进第三列，并在列内按 受阻→完成→终止 排序', () => {
    const groups = groupBoardTasks([
      t('done-old', 'done', '2026-09-11T00:00:00.000Z'),
      t('todo-1', 'todo'),
      t('blocked-1', 'blocked'),
      t('doing-1', 'in_progress'),
      t('term-1', 'terminated'),
      t('done-new', 'done', '2026-09-12T09:00:00.000Z'),
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].tasks.map((x) => x.id)).toEqual(['todo-1'])
    expect(groups[1].tasks.map((x) => x.id)).toEqual(['doing-1'])
    expect(groups[2].tasks.map((x) => x.id)).toEqual(['blocked-1', 'done-new', 'done-old', 'term-1'])
  })

  it('空任务也返回 3 个空列（面板布局稳定）；统计按状态计数', () => {
    const groups = groupBoardTasks([])
    expect(groups.map((g) => g.tasks.length)).toEqual([0, 0, 0])
    expect(countByState([t('a', 'todo'), t('b', 'todo'), t('c', 'done')])).toEqual({
      todo: 2,
      done: 1,
    })
    expect(countByState(undefined)).toEqual({})
  })
})
