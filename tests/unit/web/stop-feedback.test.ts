import { describe, expect, it } from 'vitest'
import { stopTaskFeedback } from '../../../web/src/lib/stop-feedback'

/**
 * S37：停止类操作必须如实反馈。
 * S49/D52：界面上的「停止生成」入口已移除（暂停＝跑完当前这一轮 loop 后停止生成），只保留停止任务。
 */
describe('stop-feedback · 停止任务的结果文案', () => {
  const base = { aborted: true, taskId: null, settledArtifactId: null, queued: 0 }

  it('停止任务：有任务则报任务 id，结算过快照就带上', () => {
    expect(stopTaskFeedback({ ...base, taskId: 't_1' })).toEqual({ kind: 'success', text: '已终止任务 t_1' })
    expect(stopTaskFeedback({ ...base, taskId: 't_1', settledArtifactId: 'a_2' })).toEqual({
      kind: 'success',
      text: '已终止任务 t_1，已结算快照 a_2',
    })
  })

  it('停止任务：没有进行中的任务时如实说明', () => {
    expect(stopTaskFeedback(base)).toEqual({ kind: 'info', text: '没有进行中的任务' })
  })
})
