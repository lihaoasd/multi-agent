/**
 * 会议「开场门」判定（P3 从 `composition.ts` 抽出，2026-09-14）。
 *
 * 用户定稿的流程：主持人发起 → 通知所有角色 → **主持人等全员入会** → 开场讨论。
 * 因此开场前必须回答一个问题："受邀成员是否都已入会、且手上没有等用户处理的事项？"
 * 未就绪的成员会被记一条 `hold` 事件便于追溯（不无限期卡住整场会议）。
 *
 * 抽出来的理由：这段判定原先内联在组合根里，和依赖装配混在一起。
 * 现在以**依赖注入的工厂**形式给出：只读（`tryReadMeta` / `list` / `pendingOf`），不写任何状态。
 */
import type { SessionStore } from '../session/session-store.js'
import type { ApprovalService } from '../approval/approval-service.js'
import type { QuestionService } from '../question/question-service.js'

export interface MeetingAttendanceDeps {
  sessionStore: SessionStore
  approvals: ApprovalService
  questions: QuestionService
}

/**
 * 构造开场门判定函数。
 *
 * 判定口径（与既有实现逐字一致）：
 *  1. 会议 meta 里该成员没有 `accept` 决定 → 未就绪；
 *  2. 该成员有待批审批 **或** 有待答提问 → 未就绪（入会前提是"放下等待你处理的事"）。
 */
export function createMeetingReadyCheck(
  deps: MeetingAttendanceDeps,
): (pid: string, mid: string, members: string[]) => Promise<string[]> {
  const { sessionStore, approvals, questions } = deps
  return async (pid: string, mid: string, members: string[]): Promise<string[]> => {
    const meta = await sessionStore.tryReadMeta(pid, mid).catch(() => null)
    const decisions = (meta as { meeting?: { memberDecisions?: Record<string, string> } } | null)
      ?.meeting?.memberDecisions
    const notReady: string[] = []
    for (const m of members) {
      if (decisions && decisions[m] !== 'accept') {
        notReady.push(m)
        continue
      }
      const [approval, question] = await Promise.all([
        approvals.list(pid, 'pending').then((l) => l.some((a) => a.actor === m)),
        questions.pendingOf(pid, `u_${m}`).then((q) => q !== null),
      ])
      if (approval || question) notReady.push(m)
    }
    return notReady
  }
}
