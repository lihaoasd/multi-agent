import type { Dispatcher } from '../ports/dispatcher'
import type { Logger } from '../ports/logger'
import type { ProjectStore } from '../ports/project'

/**
 * 启动自检 / 崩溃恢复（S47/D50）。
 *
 * 进程重启后有两件事必须做，否则系统会"看起来全死了"（用户报告："系统挂了，审批和询问都失效"）：
 * 1. **清残留占用**：重启后不可能还有活跃回合，`occupancy` 里的记录都是崩溃留下的；
 * 2. **补处理排队消息**（D18-③ 的承诺）：清完占用后，队列非空且未暂停的 Agent 要**补一轮**——
 *    否则那些已入队消息一直躺着，用户看到的就是"发消息没反应、审批点了没用、询问答了没用"。
 *
 * 抽成独立函数是为了可测：`main()` 里只调用它一次。
 */

export interface StartupRecoveryDeps {
  readonly project: Pick<ProjectStore, 'list'>
  readonly dispatcher: Pick<Dispatcher, 'resetStaleOccupancy' | 'resumeQueued'>
  readonly logger: Pick<Logger, 'warn' | 'info'>
}

export interface StartupRecoveryResult {
  /** 清理掉的残留占用条数合计 */
  readonly cleared: number
  /** 被补处理排队消息的 Agent（`projectId:instanceId` 形式，便于日志排查） */
  readonly resumed: readonly string[]
}

export async function recoverOnStartup(deps: StartupRecoveryDeps): Promise<StartupRecoveryResult> {
  const projects = await deps.project.list()
  if (!projects.ok) {
    deps.logger.warn('启动自检：项目列表读取失败', { code: projects.error.code, message: projects.error.message })
    return { cleared: 0, resumed: [] }
  }

  let cleared = 0
  const resumed: string[] = []
  for (const summary of projects.value) {
    const reset = await deps.dispatcher.resetStaleOccupancy(summary.id)
    if (!reset.ok) {
      deps.logger.warn('启动自检：清理残留占用失败', { projectId: summary.id, message: reset.error.message })
    } else if (reset.value > 0) {
      cleared += reset.value
      deps.logger.warn('清理了重启遗留的 Agent 占用', { projectId: summary.id, cleared: reset.value })
    }

    // D18-③：队列非空且无占用的 Agent 补一轮（暂停中的不动）
    const drain = await deps.dispatcher.resumeQueued(summary.id)
    if (!drain.ok) {
      deps.logger.warn('启动自检：补处理排队消息失败', { projectId: summary.id, message: drain.error.message })
      continue
    }
    if (drain.value.resumed.length > 0) {
      resumed.push(...drain.value.resumed.map((instanceId) => `${summary.id}:${instanceId}`))
      deps.logger.info('重启后补处理排队消息', { projectId: summary.id, resumed: drain.value.resumed })
    }
    // S21/D27：平台不再判定"未完成回合"——上一回合是否收尾由 Agent 自查会话事件（session_recent）判断。
  }
  return { cleared, resumed }
}
