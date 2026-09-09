/**
 * 工具执行协调器：审批桥（sandbox.md §5.2 / agent-runtime §7）。
 * cmd_run 命中 approval → 生成审批记录、Agent 侧等待；用户批准后由调用方
 * 调用 resumeCommand 续跑原动作（进程内批准=续跑原调用）。
 */
import { executeTool, setCommandRunner, type ToolEnv } from '../../infra/tools/executor.js'
import { ApprovalService, type ApprovalRecord } from '../approval/approval-service.js'

export class ToolCoordinator {
  constructor(private readonly approvals: ApprovalService) {}

  /** 提交高危命令执行请求：落审批记录，不执行。 */
  async requestCommand(input: {
    projectId: string
    actor: string
    sessionId?: string
    summary: string
    command: { program: string; args: string[]; cwd?: string }
    ruleId?: string
  }): Promise<ApprovalRecord> {
    return this.approvals.request({
      projectId: input.projectId,
      kind: 'command',
      actor: input.actor,
      sessionId: input.sessionId,
      summary: input.summary,
      detail: JSON.stringify(input.command),
      ruleId: input.ruleId,
    })
  }

  /** 审批通过后执行原命令（回放被拒审批 → ERR_APPROVAL_REJECTED 由调用方处理）。 */
  async resumeCommand(
    projectId: string,
    approvalId: string,
    env: Omit<ToolEnv, 'approvalBypass'>,
  ): Promise<unknown> {
    const rec = await this.approvals.get(projectId, approvalId)
    if (rec.status !== 'approved') {
      return { ok: false, code: 'APPROVAL_REJECTED', reason: `审批未通过: ${rec.status}` }
    }
    let cmd: { program: string; args: string[]; cwd?: string }
    try {
      cmd = JSON.parse(rec.detail) as { program: string; args: string[]; cwd?: string }
    } catch {
      return { ok: false, code: 'ERR_INTERNAL', reason: '审批详情损坏' }
    }
    const res = await executeTool(
      'cmd_run',
      { program: cmd.program, args: cmd.args, cwd: cmd.cwd ?? 'workdir://' },
      { ...env, approvalBypass: true },
    )
    return res
  }
}

export { setCommandRunner }
