import { describe, expect, it } from 'vitest'
import { stopTaskFeedback, stopTurnFeedback } from '../../../web/src/lib/stop-feedback'

/** S37：停止类操作必须如实反馈——"没停到东西"不能报成功 */
describe('stop-feedback · 停止生成/停止任务的结果文案', () => {
  const base = { aborted: true, taskId: null, settledArtifactId: null, queued: 0 }

  it('真的停到了在途回合：成功，并报出保留的队列条数', () => {
    expect(stopTurnFeedback({ ...base, queued: 3 })).toEqual({
      kind: 'success',
      text: '已停止生成（队列保留 3 条，下次触发时处理）',
    })
    expect(stopTurnFeedback(base)).toEqual({ kind: 'success', text: '已停止生成' })
  })

  it('没有在途回合（空闲/已暂停）：如实提示，不报成功', () => {
    expect(stopTurnFeedback({ ...base, aborted: false })).toEqual({
      kind: 'info',
      text: '当前没有正在生成的回合（该 Agent 空闲或已暂停）',
    })
  })

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
