/**
 * 服务组合根（依赖装配）：config → 各 store/service → HTTP/WS。
 * 供 index.ts 启动与测试注入复用。
 */
import { join } from 'node:path'

import type { PlatformConfig } from '../shared/config.js'
import { ProjectService } from './project/project-service.js'
import { RoleService } from './roles/role-service.js'
import { TeamService } from './team/team-service.js'
import { SessionStore } from './session/session-store.js'
import { SessionService } from './session/session-service.js'
import { AgentLoopRunner } from './agent-loop/loop-runner.js'
import type { ActiveTask, TurnContext } from './agent-loop/loop-runner.js'
import { ApprovalService } from './approval/approval-service.js'
import { ToolCoordinator } from './tools/tool-coordinator.js'
import { OccupancyStore } from './dispatcher/occupancy-store.js'
import { ArtifactService } from './artifact/artifact-service.js'
import { MemoryStore } from './memory/memory-store.js'
import { SummaryEngine } from './memory/summary-engine.js'
import { SearchService } from './search/search-service.js'
import { MeetingService } from './meeting/meeting-service.js'
import type { MeetingRecord } from './meeting/meeting-service.js'
import {
  meetingHostOpenPrompt,
  meetingHostWrapPrompt,
  meetingInviteText as meetingInviteTextOf,
  meetingMemberSpeakPrompt,
  meetingWrapUpText,
} from './meeting/meeting-prompts.js'
import { createMeetingReadyCheck } from './meeting/meeting-attendance.js'
import { taskClaimNotice, taskDelegatorNotice } from './task/task-notices.js'
import { TaskService } from './task/task-service.js'
import { dispatchTasksFromText } from './task/task-dispatch.js'
import { QuestionService } from './question/question-service.js'
import { MeetingShedStore } from './meeting/shed-store.js'
import { MeetingInviteStore } from './meeting/invite-store.js'
import { FileOwnerStore } from './artifact/file-owner-store.js'
import { CodeEditStore } from './code-edit/code-edit-store.js'
import { AttentionService } from './attention/attention-service.js'
import { deriveAgentState } from '../domain/fsm/agent-state.js'
import { RecordService } from './record/record-service.js'
import { registerServiceTools } from './tools/service-tools.js'
import { selectToolDefs } from './tools/tool-selection.js'
import {
  buildSystemPromptBlocks,
  isDispatchEligible,
  type PromptBlock,
} from './agent-loop/system-prompt.js'
import { ModelGateway } from '../infra/model/gateway.js'
import { EventBus } from '../infra/bus/event-bus.js'
import type { ToolEnv } from '../infra/tools/executor.js'
import { executeTool } from '../infra/tools/executor.js'
import { createFileStorage } from '../infra/store/file-store.js'
import { StorageFacade } from '../infra/store/project-store.js'
import { LocalFileOps } from '../infra/store/local-file-ops.js'

export interface Services {
  config: PlatformConfig
  bus: EventBus
  projectService: ProjectService
  roleService: RoleService
  teamService: TeamService
  sessionStore: SessionStore
  sessionService: SessionService
  gateway: ModelGateway
  approvals: ApprovalService
  tools: ToolCoordinator
  occupancy: OccupancyStore
  artifacts: ArtifactService
  memory: MemoryStore
  search: SearchService
  meetings: MeetingService
  tasks: TaskService
  questions: QuestionService
  attention: AttentionService
  /** 项目全局记录卡片流（任务完成 + 会议完成，只读投影） */
  records: RecordService
  /** 产出物署名与归属（file-owners.jsonl，2026-09-12） */
  fileOwners: FileOwnerStore
  /**
   * 「完整系统提示词」预览（只读，2026-09-13）：按 user 会话实时拼一遍角色实际收到的系统提示词
   * （实例提示词 + 平台注入段），与运行期同源（application/agent-loop/system-prompt.ts）。
   * 返回 null = 实例不存在。
   */
  previewSystemPrompt: (
    projectId: string,
    instanceId: string,
  ) => Promise<{ sessionType: string; blocks: PromptBlock[]; text: string } | null>
}

// ── server 门面（P4，2026-09-14）────────────────────────────────────────────
//
// 分层规则要求"server 只能依赖 application 的门面，不得深入内部模块"。
// server 原先直接 import 了若干 application 内部模块（fs-browse / export / meeting / question），
// 这些不是服务实例、无法放进 `Services`，所以在组合根统一**转出**：
// server 从此只 import `../application/composition.js`，方向清晰且可机器校验。
//
// 判断依据不变：应用层内部模块之间照常互相 import；只有**跨层**访问必须走门面。

/** 目录浏览（目录选择器）：按定义作用于用户任意目录。 */
export {
  browseDirectory,
  getHomeAndDrives,
  mkdirUnder,
} from './fs-browse/fs-browse-service.js'
/** 项目导出：整目录递归收集（zip 打包用）。 */
export { collectProjectFiles } from './export/export-service.js'
/** 会议呈现派生（进行中/已结束 + 是否排队）——规则在 domain，这里转出给 REST 层。 */
export { withDisplay, type MeetingWithDisplay } from './meeting/meeting-service.js'
/** 提问记录的最小类型 + 答复文案（REST 回答问题时需要）。 */
import type { QuestionRecord } from './question/question-service.js'
export type { QuestionRecord }
/** 工具可用性口径（角色详情用）：运行期与详情查询同源。 */
export { describeToolAvailability } from './tools/tool-selection.js'

/**
 * 提问答复文案（`QuestionService.answerText` 的门面包装）。
 * 包一层是为了让 server 不直接 import 具体服务类（分层规则的直接后果）。
 */
export async function questionAnswerText(rec: QuestionRecord): Promise<string> {
  return QuestionService.answerText(rec)
}

/** 组合全部服务。customRoleDir 缺省 = dataDir/roles。 */
export function composeServices(config: PlatformConfig, customRoleDir?: string): Services {
  const projectsRoot = join(config.dataDir, 'projects')
  const builtinRoleDir = config.roleDirs[0] ?? join(config.dataDir, 'src/shared/roles')
  const roleCustomDir = customRoleDir ?? config.roleDirs[1] ?? join(config.dataDir, 'roles')

  // 存储端口（重构 P1，2026-09-14）：项目作用域门面是 application 层唯一的 IO 边界。
  // 两种作用域：
  //   · forProjectsRoot —— "各项目目录位于该根之下"，等价于迁移前的 `new XStore(projectsRoot)`
  //   · forProject(pid) —— 单个项目的运行时目录
  const fileStorage = createFileStorage(projectsRoot)
  const storage = new StorageFacade(fileStorage, fileStorage.root)
  const projectsStore = storage.forProjectsRoot(projectsRoot)

  const bus = new EventBus()
  const projectService = new ProjectService(projectsStore, {
    artifactPolicy: {
      codeSubmitApproval: config.approval.codeSubmitApproval,
      docSubmitApproval: config.approval.docSubmitApproval,
    },
    approvalPolicy: { highRiskCommands: config.approval.highRiskCommands },
  })
  const roleService = new RoleService(builtinRoleDir, roleCustomDir)
  const teamService = new TeamService(projectService, roleService, config.models.default)
  const sessionStore = new SessionStore(projectsStore)
  const occupancy = new OccupancyStore(projectsStore)
  const gateway = new ModelGateway({ models: config.models })
  const memory = new MemoryStore(projectsStore)
  const summary = new SummaryEngine(sessionStore)
  const questions = new QuestionService(projectsStore, bus)
  // 产出物署名与归属（2026-09-12：所有产出落项目目录、署名、他人不可改）
  const fileOwners = new FileOwnerStore(projectsStore)
  // loop opts 可变：taskDispatch 依赖 tasks（后建），组合尾部再绑定（运行期读取）
  const loopOpts: ConstructorParameters<typeof AgentLoopRunner>[0] = {
    store: sessionStore,
    gateway,
    bus,
    occupancy,
    windowSize: config.context.session.rawWindow,
  }
  const loop = new AgentLoopRunner(loopOpts)
  const sessionService = new SessionService(
    sessionStore,
    bus,
    loop,
    async (pid, iid) => {
      const team = await teamService.list(pid)
      return team.find((m) => m.instanceId === iid) ?? null
    },
    async (pid) => {
      const p = await projectService.get(pid)
      return p.name
    },
    summary,
    async (pid) => teamService.list(pid),
  )
  const search = new SearchService(projectsStore, sessionStore)
  const codeEdits = new CodeEditStore(projectsStore)
  // 审批与工具协调器先建：会议入会时要作废该角色待批审批（onShed）
  const approvals = new ApprovalService(
    projectsStore,
    async (pid, sid, evt) => {
      const meta = await sessionStore.tryReadMeta(pid, sid)
      if (!meta) {
        throw new Error(`会话不存在: ${sid}`)
      }
      return sessionStore.appendEvent(meta, evt)
    },
    (_pid, rec) => {
      bus.emit('approval.result', rec.projectId, rec.sessionId ?? undefined, {
        approval: rec,
      } as unknown as Record<string, unknown>)
    },
  )
  const tools = new ToolCoordinator(approvals)
  // 会议搁置清单：入会时被作废的提问/审批留档，散会后回注给角色
  const meetingShed = new MeetingShedStore(projectsStore)
  // 会议邀请/报到台账：主持人"等全员入会"的等待条件 + loop 的 step 边界闸门
  const meetingInvites = new MeetingInviteStore(projectsStore)
  // 会议讨论链：主持人开场 → 各成员发言 → 主持人收尾 → 结束会议（生成纪要）。
  // 触发点：① meeting_start 时槽位空闲（立即开始）；② 受邀成员**全部报到**（onJoined）。
  // `config.meeting.autoStart` 关掉时本链不跑（留出手动推进/单测中间态的余地）。
  const runMeetingChain = async (input: {
    projectId: string
    meeting: { id: string }
    topic: string
    desc: string
    members: string[]
    host: string
  }): Promise<void> => {
    // 会议功能总开关关闭 → 讨论链不跑（会议 REST/工具已被拦，这里是最后一道保险）
    if (config.meeting.enabled === false || !config.meeting.autoStart) return
    const { projectId: pid, meeting, topic, desc, members, host } = input
    // 开场门（用户定稿）：等全员入会再开场；仍未就绪则记一条 hold 事件便于追溯（不无限期卡住）
    const notReady = await meetingReadyFor(pid, meeting.id, members)
    if (notReady.length) {
      await meetings.recordHold(pid, meeting.id, notReady).catch(() => undefined)
    }
    // 文案构建已抽到 ./meeting/meeting-prompts.ts（纯函数，逐字一致）
    const hostOpen = meetingHostOpenPrompt({ host, topic, desc, members })
    const hostWrap = meetingHostWrapPrompt({ topic })
    await sessionService.runAgentTurn(pid, meeting.id, host, { prompt: hostOpen }).catch(() => undefined)
    for (const m of members) {
      const p = meetingMemberSpeakPrompt({ host, topic, desc })
      await sessionService.runAgentTurn(pid, meeting.id, m, { prompt: p }).catch(() => undefined)
    }
    await sessionService.runAgentTurn(pid, meeting.id, host, { prompt: hostWrap }).catch(() => undefined)
    // 结论产出后由发起人结束会议（平台代收尾 → 生成纪要 + 散会回注）
    if (!config.meeting.autoClose) return
    const cur = (await meetings.list(pid)).find((m) => m.id === meeting.id)
    if (cur && (cur.state === 'open' || cur.state === 'blocked_waiting_user')) {
      await meetings.close(pid, meeting.id, host).catch(() => undefined)
    }
  }
  /** 开场门判定：受邀成员是否都已入会且无待处理事项（未就绪的返回）。实现见 ./meeting/meeting-attendance.ts */
  const meetingReadyFor = createMeetingReadyCheck({ sessionStore, approvals, questions })
  /** 入会通知文本：刚被邀请（`invited`）与排队轮到正式开始（`started`）两种。（文案在 meeting-prompts） */
  const meetingInviteText = (meeting: MeetingRecord, kind: 'invited' | 'started'): string =>
    meetingInviteTextOf(
      { topic: meeting.meeting.topic, desc: meeting.meeting.desc, host: meeting.meeting.host, state: meeting.state },
      kind,
    )
  const meetings = new MeetingService(
    sessionStore,
    memory,
    async (pid, host, members) => {
      // 入会 = occupancy meeting 占用（MVP：状态落盘供 UI/调度查询）
      for (const m of [host, ...members]) await occupancy.acquire(pid, m, 'meeting-slot', 'meeting')
    },
    async (pid, mid) => {
      // 散会释放
      const meta = await sessionStore.tryReadMeta(pid, mid)
      if (meta?.participants?.agents) {
        for (const m of meta.participants.agents) await occupancy.release(pid, m)
      }
    },
    // 点名成员发言：在 meeting 会话内为该成员执行一轮（Mock 直答）
    async (pid, mid, instanceId, prompt) => {
      await sessionService.runAgentTurn(pid, mid, instanceId, { prompt })
    },
    // D17-⑦ 纪要转出任务（creator=user，来源=本会议）
    async (pid, input) => {
      const r = await tasks.create({
        projectId: pid,
        title: input.title,
        desc: input.desc,
        creator: 'user',
        assignee: input.assignee,
        sessionId: input.sessionId,
      })
      return { id: r.task.id }
    },
    // 入会搁置：作废该角色"等待你处理"的提问与审批（卡片消失），并留档待散会回注
    async (pid, mid, iid) => {
      const sid = `u_${iid}`
      const dropped = await questions.cancelPending(pid, sid, `角色入会（${mid}），该提问已作废`)
      const expired = await approvals.expirePending(pid, iid, `角色入会（${mid}），该审批已作废`)
      await meetingShed.append({
        projectId: pid,
        meetingId: mid,
        instanceId: iid,
        questions: dropped,
        approvals: expired,
      })
    },
    // 散会回注：把「纪要 + 入会时被搁置的事项」写回该角色的 user 会话并唤醒一轮，继续推进任务；
    // 同时解除邀请台账（步边界闸门不再拦住这些角色）。
    async (pid, mid, minutes, participants) => {
      await meetingInvites.markLeft(pid, mid).catch(() => undefined)
      const shed = await meetingShed.listByMeeting(pid, mid)
      for (const iid of participants) {
        const mine = shed.filter((s) => s.instanceId === iid)
        await sessionService.sendUserMessage(pid, `u_${iid}`, meetingWrapUpText(mid, minutes, mine), {
          system: true,
        })
      }
    },
    // 排队会议被提升（槽位空出）→ 通知参会者"轮到我们了"；**开场等全员报到后由 onJoined 触发**
    // （主持人等的就是"所有受邀成员入会"，不由提升本身决定）。
    async (pid: string, meeting: MeetingRecord) => {
      for (const m of [meeting.meeting.host, ...meeting.meeting.members]) {
        await sessionService
          .sendUserMessage(pid, `u_${m}`, meetingInviteText(meeting, 'started'), {
            system: true,
            wake: false,
          })
          .catch(() => undefined)
      }
    },
    // 入会通知：在成员**自己的 user 会话**写一条系统消息（此前成员完全收不到"要开会"的通知）。
    // **要唤醒**（wake:true）：空闲角色需要被这条消息叫起来，才会在 step 边界闸门处停手报到；
    // 若它正在长回合里（同实例串行），这条消息排在队列后，而闸门会在它**当前回合**的下一步拦下它。
    // 代价是被叫醒的空闲角色会多跑一步（step 边界即停），换来"主持人不会永远等不到人"。
    async (pid: string, meeting: MeetingRecord, member: string, kind: 'invited' | 'started') => {
      await sessionService.sendUserMessage(pid, `u_${member}`, meetingInviteText(meeting, kind), {
        system: true,
      })
    },
    // 报到（2026-09-13）：某成员真正入会 → 记台账；**全员到齐才开场**（主持人不在回合里轮询，
    // 否则同实例单工队列会死锁）。这里直接跑讨论链：主持人开场 → 逐个点名 → 收尾 → 结束。
    async (pid: string, mid: string, member: string, allJoined: boolean) => {
      await meetingInvites.markJoined(pid, mid, member)
      if (!allJoined) return
      const rec = (await meetings.list(pid)).find((m) => m.id === mid)
      if (!rec || rec.state !== 'open') return
      await runMeetingChain({
        projectId: pid,
        meeting: rec,
        topic: rec.meeting.topic,
        desc: rec.meeting.desc ?? '',
        members: rec.meeting.members,
        host: rec.meeting.host,
      })
    },
  )

  const artifacts = new ArtifactService(projectsStore, new LocalFileOps(), approvals, async (pid, sid, evt) => {
    const meta = await sessionStore.tryReadMeta(pid, sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    return sessionStore.appendEvent(meta, evt)
  })
  // 任务栏（2026-09-12：发布 → 通知领取 → 完成回通知委派人）
  const tasks = new TaskService(projectsStore, config.task.assignByAgent, {
    // 发布/排队 → 通知受派人领取（写系统消息 + 唤醒一轮；会话不存在时静默跳过）
    notifyClaim: async (pid, assignee, task) => {
      await sessionService
        .sendUserMessage(pid, `u_${assignee}`, taskClaimNotice(task), { system: true })
        .catch(() => undefined)
    },
    // 完成/受阻/终止 → 通知委派人安排后续（creator=user 时由任务栏/前端提示，不唤醒 Agent）
    notifyDelegator: async (pid, task, event, by) => {
      if (task.creator === 'user' || task.creator === task.assignee) return
      await sessionService
        .sendUserMessage(pid, `u_${task.creator}`, taskDelegatorNotice({ task, event, by }), {
          system: true,
        })
        .catch(() => undefined)
    },
    // D17-① done/terminated 前结算未结算 code 改动 → code artifact
    settle: async (pid, task) => {
      await artifacts
        .settleCodeAggregation({
          projectId: pid,
          actor: task.assignee,
          taskId: task.id,
          taskTitle: task.title,
          edits: codeEdits,
        })
        .then(async (rec) => {
          if (rec) await tasks.linkArtifact(pid, task.id, rec.id)
        })
    },
    // 任务栏实时刷新
    bus,
  })
  const attention = new AttentionService(approvals, meetings, questions)
  // 项目全局记录（卡片流）：任务完成 + 会议完成，只读投影，不新增状态
  const records = new RecordService(tasks, (pid) => meetings.listForUi(pid))

  // 应用级工具注册（记忆/检索/受控编辑/用户交互/派单）：组合时执行一次（模块级 registry，重复调用幂等覆盖）。
  // 放在 tasks 之后，以便把 TaskService 注入 task_assign 工具。
  registerServiceTools({
    memory,
    search,
    codeEdits,
    questions,
    tasks,
    meetings,
    artifacts,
    fileOwners,
    listTeam: (pid) => projectService.listTeam(pid),
    // 会议讨论链：立即开始（槽位空闲）与排队被提升两个入口共用
    runMeetingChain,
    // 会议功能总开关：关闭时不注册 meeting_start/close/talk
    meetingsEnabled: config.meeting.enabled !== false,
  })

  // 当前激活任务（in_progress 且属本会话）：系统提示注入 + workdir_edit 聚合锚点（D15）
  const activeTaskOf = async (ctx: TurnContext): Promise<ActiveTask | null> => {
    const list = await tasks.list(ctx.projectId, {
      assignee: ctx.member.instanceId,
      state: 'in_progress',
    })
    const t = list.find((x) => x.sessionId === ctx.sessionId) ?? list[0]
    return t ? { id: t.id, title: t.title, desc: t.desc } : null
  }

  // 工具循环（function-calling）：角色白名单 ∩ 注册表 ∩ 会话可用性。
  // 可用性判定单点在 application/tools/tool-selection.ts（角色详情查询共用同一口径）。
  loopOpts.toolRuntime = {
    listTools: (ctx, sessionType) =>
      selectToolDefs(ctx.member, sessionType).map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.paramsSchema ?? { type: 'object', properties: {} },
      })),
    exec: async (ctx, sessionType, name, args) => {
      const task = await activeTaskOf(ctx)
      const env = await buildToolEnv(
        { config, projectService },
        ctx.projectId,
        ctx.member.instanceId,
        {
          taskId: task?.id,
          sessionId: ctx.sessionId,
          sessionType: sessionType === 'meeting' ? 'meeting' : 'user',
        },
      )
      return executeTool(name, args, env)
    },
    requestApproval: async (ctx, name, args) => {
      if (name !== 'cmd_run') return null
      const argv = Array.isArray(args.args) ? args.args.map(String) : []
      const rec = await tools.requestCommand({
        projectId: ctx.projectId,
        actor: ctx.member.instanceId,
        sessionId: ctx.sessionId,
        summary: `执行命令：${String(args.program ?? '')} ${argv.join(' ')}`.trim().slice(0, 200),
        command: {
          program: String(args.program ?? ''),
          args: argv,
          cwd: String(args.cwd ?? 'workdir://'),
        },
      })
      return rec.id
    },
    activeTask: activeTaskOf,
    // 待领取任务（任务栏上派给我、尚未领取的）：注入 [待领取任务] 提示块，引导 task_claim 领取
    pendingTasks: async (ctx: TurnContext) =>
      (await tasks.list(ctx.projectId, { assignee: ctx.member.instanceId, state: 'todo' }))
        .sort((a, b) => (a.ts < b.ts ? -1 : 1))
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: t.title, desc: t.desc, creator: t.creator })),
    // 任务栏现状（共享视野，仅 pm/product 的提示会用到）：避免两位管理者重复派同一件事
    boardTasks: async (ctx: TurnContext) =>
      (await tasks.list(ctx.projectId))
        .filter((t) => t.state === 'todo' || t.state === 'in_progress')
        .slice(0, 12)
        .map((t) => ({
          id: t.id,
          title: t.title,
          assignee: t.assignee,
          creator: t.creator,
          state: t.state === 'todo' ? '待领取' : '进行中',
        })),
    // 产出物签名与归属：告诉我"自己的产出物在哪、别人的只读"（2026-09-12）
    fileOwnership: async (ctx: TurnContext) => {
      const all = await fileOwners.list(ctx.projectId)
      const team = await projectService.listTeam(ctx.projectId)
      const nameOf = (owner: string) =>
        team.find((m) => m.instanceId === owner)?.displayName ?? owner
      return {
        mine: all
          .filter((r) => r.owner === ctx.member.instanceId)
          .slice(0, 8)
          .map((r) => ({ relPath: r.relPath, lastAt: r.lastAt, lastTaskId: r.lastTaskId })),
        others: all
          .filter((r) => r.owner !== ctx.member.instanceId)
          .slice(0, 8)
          .map((r) => ({
            relPath: r.relPath,
            owner: r.owner,
            ownerName: nameOf(r.owner),
            lastAt: r.lastAt,
          })),
      }
    },
    // 单回合工具步数：**不限制（无限轮）**，模型不再调用工具即结束；
    // 空转由 loop 的无进展保护兜底（同工具+同入参+同结果连续 3 次即停）。
    maxSteps: 0,
    // 回合结束（占用释放后）把回合内积压的提问推给前端：卡片出现 == 角色进入"等待你处理"
    flushDeferred: async (ctx: TurnContext) => {
      questions.flushPending(ctx.projectId, ctx.sessionId)
    },
    // 角色运行态（单点推导）：有待答提问/待批审批 → waiting。
    // loop 用它决定"该不该开工"以及回合结束广播什么状态，保证与 GET /agents 一致。
    runtimeState: async (ctx: TurnContext) => {
      const iid = ctx.member.instanceId
      const [approval, question] = await Promise.all([
        approvals
          .list(ctx.projectId, 'pending')
          .then((list) => list.some((a) => a.actor === iid))
          .catch(() => false),
        questions
          .pendingOf(ctx.projectId, ctx.sessionId)
          .then((q) => q !== null && q.asker === iid)
          .catch(() => false),
      ])
      return deriveAgentState({
        enabled: ctx.member.enabled,
        occupancy: await occupancy.get(ctx.projectId, iid).catch(() => null),
        hasPendingApproval: approval,
        hasPendingQuestion: question,
      })
    },
    // step 边界闸门（2026-09-13）：被会议邀请（平台已记报到）→ 结束当前工作、去开会。
    // 只在**一步工具执行完**后询问，角色不会停在半个 step 上；返回的文本会落成系统消息。
    shouldYield: async (ctx: TurnContext) => {
      const iid = ctx.member.instanceId
      // 会议关闭时没有邀请 → 直接放行（省一次读盘）
      if (config.meeting.enabled === false) return null
      // 会议会话内发言不受此闸门约束（它本来就生在会议里）
      if (ctx.sessionId.startsWith('m_')) return null
      const pending = await meetingInvites.hasPendingInvite(ctx.projectId, iid).catch(() => false)
      if (!pending) return null
      return (
        '【系统】你被拉进了一个会议：请**立即停止手上的工作**（任务保持当前状态，不要收尾/不要上报完成）。' +
        '你已经入会报到，等主持人在会议里点名发言即可；散会后平台会把会议结论与你会前搁置的事项回注给你，再继续。'
      )
    },
  }

  /**
   * 「完整系统提示词」预览（只读，2026-09-13）：**复用运行期同一批钩子**按 user 会话实时拼一遍，
   * 让用户看到"模型实际收到什么"（实例提示词 + 平台注入段）。与运行期同源 = system-prompt.ts。
   * 返回 null = 实例不存在（路由层转 404）。
   */
  const previewSystemPrompt = async (
    pid: string,
    iid: string,
  ): Promise<{ sessionType: string; blocks: PromptBlock[]; text: string } | null> => {
    const project = await projectService.get(pid)
    const member = project.team.find((m) => m.instanceId === iid)
    if (!member) return null
    const sessionType = 'user'
    const assignableMembers = project.team
      .filter((m) => m.enabled)
      .map((m) => ({
        instanceId: m.instanceId,
        displayName: m.displayName,
        roleTemplateId: m.roleTemplateId,
      }))
    // 与会话服务一致：user 会话 id 恒为 u_<instanceId>（activeTask 的归属锚点也用它）
    const ctx: TurnContext = {
      projectId: pid,
      sessionId: `u_${iid}`,
      member,
      scenario: project.name,
      assignableMembers,
    }
    const rt = loopOpts.toolRuntime
    const toolNames = (rt?.listTools(ctx, sessionType) ?? []).map((t) => t.name)
    const activeTask = rt?.activeTask ? await rt.activeTask(ctx).catch(() => null) : null
    const pendingTasks = rt?.pendingTasks ? await rt.pendingTasks(ctx).catch(() => []) : []
    const boardTasks = rt?.boardTasks ? await rt.boardTasks(ctx).catch(() => []) : []
    const ownership = rt?.fileOwnership ? await rt.fileOwnership(ctx).catch(() => null) : null
    const blocks = buildSystemPromptBlocks({
      member,
      scenario: project.name,
      sessionType,
      assignableMembers,
      activeTask: activeTask ?? null,
      pendingTasks,
      boardTasks,
      ownership: ownership ?? null,
      toolNames,
      dispatchEligible: isDispatchEligible({
        taskDispatchEnabled: !!loopOpts.taskDispatch,
        sessionType,
        roleTemplateId: member.roleTemplateId,
      }),
    })
    return { sessionType, blocks, text: blocks.map((b) => b.text).join('\n') }
  }

  // 甲模式任务分派钩子（2026-09-09）：config.task.assignByAgent 时由 pm/product 的
  // user 会话回合解析分派指令并创建/激活任务（loop 运行期经 loopOpts 读取）。
  loopOpts.taskDispatch = config.task.assignByAgent
    ? {
        run: async (ctx, text) => {
          const emitTool = async (
            kind: 'tool_call' | 'tool_result',
            payload: Record<string, unknown>,
          ) => {
            const meta = await sessionStore.tryReadMeta(ctx.projectId, ctx.sessionId)
            if (!meta) return
            const evt = await sessionStore.appendEvent(meta, {
              kind,
              sender: ctx.member.instanceId,
              role: 'agent',
              payload,
            })
            bus.emitLogEvent(ctx.projectId, evt)
          }
          const team = await projectService.listTeam(ctx.projectId)
          return dispatchTasksFromText({
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            actorId: ctx.member.instanceId,
            actorName: ctx.member.displayName,
            text,
            team,
            tasks,
            emitTool,
          })
        },
      }
    : undefined

  return {
    config,
    bus,
    projectService,
    roleService,
    teamService,
    sessionStore,
    sessionService,
    gateway,
    approvals,
    tools,
    occupancy,
    artifacts,
    memory,
    search,
    meetings,
    tasks,
    questions,
    attention,
    records,
    fileOwners,
    previewSystemPrompt,
  }
}

/** 组装 ToolEnv（路径根 + 项目策略）供工具执行/审批续跑使用。 */
export async function composeToolEnv(
  svc: Services,
  projectId: string,
  instanceId: string,
  opts: { taskId?: string; sessionId?: string; sessionType?: 'user' | 'meeting' } = {},
): Promise<ToolEnv> {
  return buildToolEnv(
    { config: svc.config, projectService: svc.projectService },
    projectId,
    instanceId,
    opts,
  )
}

/** ToolEnv 构造（composition 内部与 composeToolEnv 共用）。 */
export async function buildToolEnv(
  deps: Pick<Services, 'config' | 'projectService'>,
  projectId: string,
  instanceId: string,
  opts: { taskId?: string; sessionId?: string; sessionType?: 'user' | 'meeting' } = {},
): Promise<ToolEnv> {
  const project = await deps.projectService.get(projectId)
  const team = await deps.projectService.listTeam(projectId)
  const member = team.find((m) => m.instanceId === instanceId)
  if (!member) throw new Error(`实例不存在: ${instanceId}`)
  const projectsRoot = join(deps.config.dataDir, 'projects')
  const runtimeRoot = join(projectsRoot, projectId)
  return {
    roots: {
      wsRoot: join(runtimeRoot, 'workspaces', instanceId),
      workdirRoot: project.workdir,
      roRoots: [],
      runtimeRoot,
    },
    instanceId,
    sessionType: opts.sessionType ?? 'user',
    projectId,
    approvalPolicy: project.approvalPolicy,
    offline: deps.config.sandbox.network === 'offline',
    taskId: opts.taskId,
    sessionId: opts.sessionId,
  }
}
