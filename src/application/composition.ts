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
import { TaskService } from './task/task-service.js'
import { dispatchTasksFromText } from './task/task-dispatch.js'
import { QuestionService } from './question/question-service.js'
import { MeetingShedStore, type ShedRecord } from './meeting/shed-store.js'
import { MeetingInviteStore } from './meeting/invite-store.js'
import { FileOwnerStore } from './artifact/file-owner-store.js'
import { CodeEditStore } from './code-edit/code-edit-store.js'
import { AttentionService } from './attention/attention-service.js'
import { deriveAgentState } from './runtime-state.js'
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

/** 组合全部服务。customRoleDir 缺省 = dataDir/roles。 */
export function composeServices(config: PlatformConfig, customRoleDir?: string): Services {
  const projectsRoot = join(config.dataDir, 'projects')
  const builtinRoleDir = config.roleDirs[0] ?? join(config.dataDir, 'src/shared/roles')
  const roleCustomDir = customRoleDir ?? config.roleDirs[1] ?? join(config.dataDir, 'roles')

  const bus = new EventBus()
  const projectService = new ProjectService(projectsRoot, {
    artifactPolicy: {
      codeSubmitApproval: config.approval.codeSubmitApproval,
      docSubmitApproval: config.approval.docSubmitApproval,
    },
    approvalPolicy: { highRiskCommands: config.approval.highRiskCommands },
  })
  const roleService = new RoleService(builtinRoleDir, roleCustomDir)
  const teamService = new TeamService(projectService, roleService, config.models.default)
  const sessionStore = new SessionStore(projectsRoot)
  const occupancy = new OccupancyStore(projectsRoot)
  const gateway = new ModelGateway({ models: config.models })
  const memory = new MemoryStore(projectsRoot)
  const summary = new SummaryEngine(sessionStore)
  const questions = new QuestionService(projectsRoot, bus)
  // 产出物署名与归属（2026-09-12：所有产出落项目目录、署名、他人不可改）
  const fileOwners = new FileOwnerStore(projectsRoot)
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
  const search = new SearchService(projectsRoot, sessionStore)
  const codeEdits = new CodeEditStore(projectsRoot)
  // 审批与工具协调器先建：会议入会时要作废该角色待批审批（onShed）
  const approvals = new ApprovalService(
    projectsRoot,
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
  const meetingShed = new MeetingShedStore(projectsRoot)
  // 会议邀请/报到台账：主持人"等全员入会"的等待条件 + loop 的 step 边界闸门
  const meetingInvites = new MeetingInviteStore(projectsRoot)
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
    const hostOpen =
      `【会议开场】你是主持人（${host}）。会议主题「${topic}」` +
      (desc ? `，描述：${desc}` : '') +
      `，参会：${members.join('、')} 与用户。请先开场：说明议题与期望产出；` +
      '然后可用 meeting_talk 逐个点名成员发言（他们的发言会写进会议会话）。'
    const hostWrap =
      `【会议收尾】会议「${topic}」的成员发言已写入会议会话。请阅读后给出：结论、待办（谁做什么）、` +
      '仍需用户拍板的事项；如需结束会议可调用 meeting_close。'
    await sessionService.runAgentTurn(pid, meeting.id, host, { prompt: hostOpen }).catch(() => undefined)
    for (const m of members) {
      const p =
        `【会议邀请】${host} 邀请你参加「${topic}」` +
        (desc ? `（${desc}）` : '') +
        '。请在会议中发表意见：结论 + 理由 + 需要谁配合（简明，不要复述别人）。'
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
  /** 开场门判定：受邀成员是否都已入会且无待处理事项（未就绪的返回）。 */
  const meetingReadyFor = async (pid: string, mid: string, members: string[]): Promise<string[]> => {
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
  /** 入会通知文本：刚被邀请（`invited`）与排队轮到正式开始（`started`）两种。 */
  const meetingInviteText = (meeting: MeetingRecord, kind: 'invited' | 'started'): string => {
    const topic = meeting.meeting.topic
    const desc = meeting.meeting.desc?.trim()
    if (kind === 'started') {
      return (
        `【会议开始】${meeting.meeting.host} 邀请的会议「${topic}」现在开始` +
        `${desc ? `：${desc}` : ''}。\n会议已开始，你的团队状态已是「会议中」。` +
        '你**本轮不用动手**：等主持人开场后点名发言即可（发言写进会议会话）。'
      )
    }
    const queued = meeting.state === 'queued'
    return (
      `【会议邀请】${meeting.meeting.host} 拉你参加「${topic}」${desc ? `：${desc}` : ''}。\n` +
      (queued
        ? '当前有别的会议在进行，本场**排队等待**中，轮到时平台会自动开始并在这里通知你。'
        : '会议已开始，你的团队状态已是「会议中」。') +
      '你**本轮不用动手**：等主持人开场后点名发言即可（发言写进会议会话）。'
    )
  }
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

  const artifacts = new ArtifactService(projectsRoot, approvals, async (pid, sid, evt) => {
    const meta = await sessionStore.tryReadMeta(pid, sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    return sessionStore.appendEvent(meta, evt)
  })
  // 任务栏（2026-09-12：发布 → 通知领取 → 完成回通知委派人）
  const tasks = new TaskService(projectsRoot, config.task.assignByAgent, {
    // 发布/排队 → 通知受派人领取（写系统消息 + 唤醒一轮；会话不存在时静默跳过）
    notifyClaim: async (pid, assignee, task) => {
      await sessionService
        .sendUserMessage(
          pid,
          `u_${assignee}`,
          `【系统】任务栏有任务待你领取 ${task.id}「${task.title}」` +
            (task.desc ? `：${task.desc.slice(0, 300)}` : '') +
            `（委派人：${task.creator}）。请调用 task_claim 领取并开工；` +
            '完成后必须调用 task_update(state=done, note=一句话完成总结)，并在回复里给用户一段完成总结' +
            '（做了什么/产出文件/验证结果/遗留）。若暂时不能接，请用 task_update 置 blocked 并说明原因。',
          { system: true },
        )
        .catch(() => undefined)
    },
    // 完成/受阻/终止 → 通知委派人安排后续（creator=user 时由任务栏/前端提示，不唤醒 Agent）
    notifyDelegator: async (pid, task, event, by) => {
      if (task.creator === 'user' || task.creator === task.assignee) return
      const zh = event === 'done' ? '已完成' : event === 'blocked' ? '受阻' : '已终止'
      const note = task.resultNote?.trim()
      await sessionService
        .sendUserMessage(
          pid,
          `u_${task.creator}`,
          `【系统】你委派的任务 ${task.id}「${task.title}」${zh}（受派人 ${by}）。` +
            (note ? `\n受派人总结：${note.slice(0, 500)}` : '') +
            '\n请据此安排后续：验收产出、派发下一步任务，或发起会议对齐。',
          { system: true },
        )
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

/**
 * 散会回注文本（2026-09-12）：会议关闭后写回每个参会者 user 会话的系统消息。
 * 内容 = 会议纪要 + 该角色入会时被搁置（作废）的提问/审批清单 + "据此继续推进任务"的指令。
 * 角色看到它就会被唤醒续跑一轮，带着会议结论继续做（用户选择的"自动续跑"）。
 */
function meetingWrapUpText(meetingId: string, minutes: string, shed: ShedRecord[]): string {
  const droppedQ = shed.flatMap((s) => s.questions)
  const droppedA = shed.flatMap((s) => s.approvals)
  const lines = [
    `【会议结论】会议 ${meetingId} 已结束，纪要如下：`,
    minutes,
    '',
  ]
  if (droppedQ.length || droppedA.length) {
    lines.push('【入会时被搁置的事项】你开会前正在等用户处理，现已被搁置（提问作废、审批作废）：')
    for (const q of droppedQ) lines.push(`- 询问用户「${q.question}」（提问 ${q.id}，已作废）`)
    for (const a of droppedA) lines.push(`- 待批操作「${a.summary}」（审批 ${a.id}，已作废）`)
    lines.push('这些事项**不会再有用户答复**：请结合上面的会议结论重新判断，不要等待原答复。')
  }
  lines.push(
    '',
    '请据此**继续推进你手上的任务**：若会议结论已覆盖原疑问，直接按结论执行；' +
      '若仍需用户拍板，重新用 ask_user 提问（可带上会议结论作为背景）；' +
      '若任务状态有变化，用 task_update 上报。',
  )
  return lines.join('\n')
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
