import { describe, expect, it } from 'vitest'
import { taskReportNotice } from '../../../src/application/task/task-service'

/**
 * S36/D39：汇报通知不能只播报事实——委派人被唤醒后必须知道"据此继续"，
 * 否则子任务结果落不进它的计划（用户口径："派发人接收到任务完成，继续执行任务"）。
 */
describe('S36 · 任务汇报通知文案（taskReportNotice）', () => {
  const base = { assignee: 'dev_1', taskId: 't_1', title: '实现登录模块', note: null as string | null }

  it('done：带任务标识与状态，并明确要求"据此继续"', () => {
    const text = taskReportNotice({ ...base, state: 'done' })
    // 前缀是平台任务通知的既有约定（脚本/用例按 `[任务]` 识别）
    expect(text.startsWith('[任务]')).toBe(true)
    expect(text).toContain('dev_1 已汇报任务 t_1《实现登录模块》：done')
    expect(text).toContain('请据此继续你的计划')
    // 所有角色都有 task_update：无事可做时要给出收尾出口
    expect(text).toContain('task_update')
  })

  it('done：note 非空给说明行，空白 note 不留空行', () => {
    expect(taskReportNotice({ ...base, state: 'done', note: ' 已实现并自测 ' })).toContain('说明：已实现并自测')
    expect(taskReportNotice({ ...base, state: 'done', note: '   ' })).not.toContain('说明：')
  })

  it('blocked：要求当场安排后续，不许停在原地', () => {
    const text = taskReportNotice({ ...base, state: 'blocked' })
    expect(text).toContain('：blocked')
    expect(text).toContain('不要停在原地等待')
    expect(text).toContain('ask_user')
  })

  it('terminated：要求决定是否重新安排', () => {
    expect(taskReportNotice({ ...base, state: 'terminated' })).toContain('决定是否重新安排')
  })

  it('不点名 task_assign（该工具只在 pm 白名单里，派发人不一定是 pm）', () => {
    for (const state of ['done', 'blocked', 'terminated'] as const) {
      expect(taskReportNotice({ ...base, state })).not.toContain('task_assign')
    }
  })
})
