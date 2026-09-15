import type { IdGenerator } from '../../ports/id'
import type { TurnRunner } from '../../ports/turn'
import { ok, type Result } from '../../shared/result'

/**
 * S3 占位回合执行器：只写回合边界与一条可读回执，**不调用模型、不跑工具**。
 *
 * 它的存在是为了让 S3 能验收"会话 / 单工 / 队列 / 先盘后推 / WS 推送"这条链路；
 * S4 会用真正的 loop（策略 + 上下文组装 + 工具 + 模型流式）替换它，届时此文件删除。
 * 事件形状与真实回合一致（turn_start → … → turn_end），因此前端与投影代码无需改动。
 */
export function createPlaceholderTurnRunner(ids: IdGenerator): TurnRunner {
  return {
    async runTurn(context): Promise<Result<void>> {
      const started = await context.emit({
        kind: 'turn_start',
        turn: context.turn,
        payload: { turnId: ids.next('turn'), loopStep: 'act', executor: 'placeholder' },
      })
      if (!started.ok) return started

      await context.emit({
        kind: 'thought',
        turn: context.turn,
        payload: {
          text: '（S3 占位执行器）真正的 agent loop 在 S4 接入：届时会组装上下文、按策略调用模型与工具。',
        },
      })

      await context.emit({
        kind: 'message',
        turn: context.turn,
        payload: {
          role: 'agent',
          sender: context.instanceId,
          text: `已收到你的消息：「${context.userText}」。\n\n当前是 S3 阶段（会话与单工调度），回复由占位执行器生成；S4 接入 agent loop 后这里会变成真实模型输出。`,
          content: {
            text: `已收到你的消息：「${context.userText}」。\n\n当前是 S3 阶段（会话与单工调度），回复由占位执行器生成；S4 接入 agent loop 后这里会变成真实模型输出。`,
          },
          model: null,
          loopStep: 'act',
        },
      })

      const ended = await context.emit({
        kind: 'turn_end',
        turn: context.turn,
        payload: { ok: true },
      })
      return ended.ok ? ok(undefined) : ended
    },
  }
}
