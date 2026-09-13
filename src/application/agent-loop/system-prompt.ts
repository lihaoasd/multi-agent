/**
 * Agent 回合**系统提示词拼装（单点真相）**，2026-09-13 从 loop-runner 抽出。
 *
 * 为什么抽出来：运行期（`AgentLoopRunner` 每回合拼给模型）与「完整系统提示词预览」
 * （`GET /api/projects/:pid/agents/:iid/system-prompt`）必须是同一份规则——
 * 抄一份必然漂移，而"界面看到的"和"模型收到的"不一致正是本功能要消除的问题。
 *
 * 段序（固定，空段跳过）：
 *   实例提示词 → [场景设定] → [执行模式] → 回复要求 → [可用工具] → [我的/他人产出物]
 *   → [当前任务] → [待领取任务] → [任务栏现状]（甲模式 pm/product）→ [团队成员] → [任务栏（甲模式已开启）]
 *
 * 前 1 段来自角色实例配置（入库、可查看）；其余为**平台按当时状态实时注入**（任务/产出物归属/
 * 团队名册/工具集，不入库）。
 */
import type { TeamMemberConfig } from '../../shared/types/project.js'

/** 当前激活任务（注入提示 + workdir_edit 聚合锚点）。 */
export interface ActiveTask {
  id: string
  title: string
  desc: string
}

/** 待领取任务（任务栏上派给我、尚未领取）。 */
export interface PendingTask {
  id: string
  title: string
  desc: string
  creator: string
}

/** 任务栏活跃任务（给 pm/product 的共享视野）。 */
export interface BoardTask {
  id: string
  title: string
  assignee: string
  creator: string
  state: string
}

/** 产出物归属（署名 + 只读约束）。 */
export interface FileOwnership {
  mine: Array<{ relPath: string; lastAt: string; lastTaskId: string | null }>
  others: Array<{ relPath: string; owner: string; ownerName: string; lastAt: string }>
}

/** 团队成员（名册/可派对象）。 */
export interface RosterMember {
  instanceId: string
  displayName: string
  roleTemplateId?: string
}

/** 拼装输入：与运行期回合上下文一一对应（预览按 user 会话取实时值）。 */
export interface SystemPromptInput {
  member: TeamMemberConfig
  /** 项目名（[场景设定] 里的"项目"） */
  scenario: string
  /** 会话类型（user/meeting）：影响 [可用工具] 与甲模式分派段 */
  sessionType: string
  assignableMembers: RosterMember[]
  activeTask: ActiveTask | null
  pendingTasks: PendingTask[]
  boardTasks: BoardTask[]
  ownership: FileOwnership | null
  /** 该会话实际可用的工具名（运行期 = toolRuntime.listTools） */
  toolNames: string[]
  /** 甲模式分派是否对该角色/会话生效（[任务栏现状] 与 [任务栏（甲模式已开启）] 的条件） */
  dispatchEligible: boolean
}

/** 提示词段标识（UI 逐段标注来源用）。 */
export type PromptBlockId =
  | 'instance-prompt'
  | 'scene'
  | 'loop-mode'
  | 'reply-rules'
  | 'tools'
  | 'ownership'
  | 'active-task'
  | 'pending-tasks'
  | 'board'
  | 'roster'
  | 'dispatch'

/** 提示词段：origin=role-config 来自角色实例配置；platform=平台实时注入。 */
export interface PromptBlock {
  id: PromptBlockId
  origin: 'role-config' | 'platform'
  title: string
  text: string
}

/** 甲模式可派单角色。 */
export const DISPATCH_ROLES = new Set(['pm', 'product'])

/** 甲模式分派是否生效（运行期与预览共用，避免两处条件漂移）。 */
export function isDispatchEligible(input: {
  taskDispatchEnabled: boolean
  sessionType: string
  roleTemplateId: string
}): boolean {
  return (
    input.taskDispatchEnabled &&
    input.sessionType === 'user' &&
    DISPATCH_ROLES.has(input.roleTemplateId)
  )
}

/**
 * 拼装系统提示词（逐段）。运行期用 `buildSystemPrompt`（拼串），预览用本函数（逐段标注来源）。
 * 注意：实例提示词段 text 末尾自带 `'\n'`，等价于历史实现的"提示词后跟一个空行"分隔，
 * 因此 `buildSystemPrompt` 的产物与抽函数前逐字节一致。
 */
export function buildSystemPromptBlocks(input: SystemPromptInput): PromptBlock[] {
  const { member: m, scenario, sessionType, assignableMembers, toolNames } = input
  const blocks: PromptBlock[] = []
  const strategy = m.loop?.strategy ?? 'direct'
  const strategyHint: Record<string, string> = {
    direct: '采用直接作答方式。',
    reflective: '先给出初稿，再自查一遍（覆盖边界与漏洞）后输出修订版结论。',
    'plan-execute': '先给出简短执行计划，再按计划逐步说明并输出结论。',
  }

  blocks.push({
    id: 'instance-prompt',
    origin: 'role-config',
    title: '角色提示词（实例配置）',
    text: `${m.prompt ?? ''}\n`,
  })
  blocks.push({
    id: 'scene',
    origin: 'platform',
    title: '场景设定',
    text: `[场景设定] 你是「${m.displayName}」（项目：${scenario}）。用户是你的老板与最终决策者。`,
  })
  blocks.push({
    id: 'loop-mode',
    origin: 'platform',
    title: '执行模式（来自 loop 策略）',
    text: `[执行模式] ${strategyHint[strategy] ?? strategyHint.direct}`,
  })
  blocks.push({
    id: 'reply-rules',
    origin: 'platform',
    title: '回复要求',
    text: '回复要求：中文、简洁、直接给结论；涉及需要用户拍板/审批的事项必须明确说明，不替用户做决定。',
  })

  if (toolNames.length) {
    const hasAsk = toolNames.includes('ask_user')
    const hasWrite = toolNames.includes('workdir_edit')
    const hasSubmit = toolNames.includes('artifact_submit')
    blocks.push({
      id: 'tools',
      origin: 'platform',
      title: `可用工具（${sessionType} 会话）`,
      text:
        `[可用工具] ${toolNames.join('、')}。` +
        '需要查看/修改工作目录或检索信息时请直接调用工具，不要凭空猜测文件内容；' +
        (hasWrite
          ? '**所有产出直接写进项目工作目录**（workdir_edit，路径用 workdir://）：项目目录是唯一交付地，没有私有草稿区；' +
            '你只能改自己名下的文件（见 [我的产出物]），别人的产出物只能读、不能改，需要新版本请另建新文件。'
          : '') +
        '运行命令用 cmd_run（高危命令会转用户审批）；完成后汇报改了什么、验证结果。' +
        (hasSubmit
          ? '需要把某些文件登记成一条产出物（版本快照 + 署名）时用 artifact_submit。'
          : '') +
        (hasAsk
          ? '需要用户拍板、确认或做选择时，用 ask_user 提问（confirm 确认 / single 单选 / multi 多选 / text 文本），' +
            '**一次要问多件事就用一次调用传 questions 数组（问题列表，1~6 题）**——用户在**同一张卡片里逐题作答、一次提交**；' +
            '不要并发多次调用 ask_user，也不要分多轮追问。' +
            '**需要用户拍板/批准的事要先问再做**：ask_user 与需要审批的命令都会**立即挂起本回合**（你进入「等待你处理」），' +
            '所以不要先把活干完再来问——先拿到答复再动手，避免方向错了白做。'
          : '') +
        '\n需要审批的命令（高危/未放行的命令）提交后会**立即挂起本回合**，等用户批准；' +
        '批准后平台会把执行结果回给你，你再继续，不要重复申请、也不要试图绕过。' +
        '\n步数不设上限：请高效推进并把事情做完（不要为了凑步数而反复调用同一工具——' +
        '同一工具+同一入参+同一结果连续 3 次会被平台判定为原地空转并停止本回合）。',
    })
  }

  // 产出物署名与归属：告诉角色"自己的产出物在哪、别人的只读"（2026-09-12）
  const ownership = input.ownership
  if (ownership && (ownership.mine.length || ownership.others.length)) {
    const lines: string[] = []
    if (ownership.mine.length) {
      lines.push('[我的产出物（可改）]')
      for (const f of ownership.mine) {
        lines.push(
          `- ${f.relPath}（最近修改 ${f.lastAt.slice(11, 16)}${f.lastTaskId ? `，任务 ${f.lastTaskId}` : ''}）`,
        )
      }
    }
    if (ownership.others.length) {
      lines.push('[他人产出物（只读，不可改；需要新版本请另建文件）]')
      for (const f of ownership.others) {
        lines.push(`- ${f.relPath} —— 属 ${f.ownerName}（${f.owner}）`)
      }
    }
    blocks.push({
      id: 'ownership',
      origin: 'platform',
      title: '产出物归属（实时）',
      text: lines.join('\n'),
    })
  }

  if (input.activeTask) {
    const activeTask = input.activeTask
    blocks.push({
      id: 'active-task',
      origin: 'platform',
      title: '当前任务（实时）',
      text:
        `[当前任务] ${activeTask.id}「${activeTask.title}」（in_progress）` +
        (activeTask.desc ? `：${activeTask.desc}` : '') +
        '\n纪律（收尾三件套，务必在任务做完时一次做完）：' +
        '① 需要交付文件时用 artifact_submit 登记；' +
        '② 调用 task_update（state=done，**note=一句话完成总结**）上报状态——平台据此更新任务栏并**通知委派人**；' +
        '③ 在回复里给用户一段**完成总结**：做了什么、产出文件（工作目录相对路径）、验证结果、遗留问题与建议。' +
        '\n受阻时置 blocked 并说明原因；不要只在聊天里口头说完成，也不要做到一半就结束回合。',
    })
  }

  if (input.pendingTasks.length) {
    const hasClaim = toolNames.includes('task_claim')
    const lines = [
      `[待领取任务] 任务栏上有 ${input.pendingTasks.length} 条派给你的任务（待领取）：`,
      ...input.pendingTasks.map(
        (t) =>
          `- ${t.id}「${t.title}」（委派人 ${t.creator}）${t.desc ? `：${t.desc.slice(0, 200)}` : ''}`,
      ),
    ]
    lines.push(
      hasClaim
        ? '领取方式：调用 task_claim（可带 taskId；缺省领取最早的一条）——领取后状态变为进行中，你才开始执行。' +
            '完成后必须 task_update（state=done，note=完成总结）并在回复里给用户一段完成总结。' +
            '若手上还有进行中的任务或暂时接不了，请用 task_update 置 blocked 并说明原因，不要默默忽略。'
        : '如需领取请告知用户，由用户协调。',
    )
    blocks.push({
      id: 'pending-tasks',
      origin: 'platform',
      title: '待领取任务（实时）',
      text: lines.join('\n'),
    })
  }

  // 共享视野（pm/product）：两人都能看到任务栏上已有的活跃任务，避免重复派同一件事
  if (input.boardTasks.length && input.dispatchEligible) {
    const lines = [
      `[任务栏现状] 当前活跃任务（待领取/进行中）共 ${input.boardTasks.length} 条：`,
      ...input.boardTasks.map(
        (t) => `- ${t.id}「${t.title}」→ ${t.assignee}（发布者 ${t.creator}，${t.state}）`,
      ),
      '发布前请先对照本清单：同一受派人的同一件事**不要重复发布**（平台会自动去重并回执提示）；',
      '需要补充说明时，在已有任务上对齐或在会议里沟通，不要另发一条同名任务。',
    ]
    blocks.push({
      id: 'board',
      origin: 'platform',
      title: '任务栏现状（实时，仅管理者）',
      text: lines.join('\n'),
    })
  }

  const roster = buildTeamRoster(m, assignableMembers, toolNames)
  if (roster) {
    blocks.push({ id: 'roster', origin: 'platform', title: '团队名册（实时）', text: roster })
  }
  const hint = input.dispatchEligible ? buildDispatchHint(m, assignableMembers, toolNames) : null
  if (hint) {
    blocks.push({ id: 'dispatch', origin: 'platform', title: '任务分派说明（甲模式）', text: hint })
  }
  return blocks
}

/** 运行期入口：拼成完整系统提示词（内容 = 各段按 '\n' 连接）。 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  return buildSystemPromptBlocks(input)
    .map((b) => b.text)
    .join('\n')
}

/** 团队名册：让每个角色都知道队伍里有哪些成员（可直接用实例 id 协作/开会/派单）。 */
function buildTeamRoster(
  member: TeamMemberConfig,
  assignableMembers: RosterMember[],
  toolNames: string[],
): string | null {
  const peers = assignableMembers.filter((x) => x.instanceId !== member.instanceId)
  if (!peers.length) return null
  const me = `我：${member.instanceId}（${member.displayName}）`
  const others = peers.map((p) => `${p.instanceId}（${p.displayName}）`).join('、')
  const hasMeeting = toolNames.includes('meeting_start')
  return (
    `[团队成员] ${me}｜其他成员：${others}。` +
    '需要协作、派活或对齐时直接用这些实例 id；' +
    (hasMeeting
      ? '需要评审/对齐时调用 meeting_start 发起会议（自行定主题、描述与参会人）。'
      : '需要开会时请让用户发起会议。')
  )
}

/** 甲模式分派说明（pm/product 的 user 会话且提供了可派对象时注入）。 */
function buildDispatchHint(
  member: TeamMemberConfig,
  assignableMembers: RosterMember[],
  toolNames: string[],
): string | null {
  const peers = assignableMembers.filter((x) => x.instanceId !== member.instanceId)
  if (!peers.length) return null
  const list = peers.map((p) => `${p.instanceId}（${p.displayName}）`).join('、')
  const hasTool = toolNames.includes('task_assign')
  const lines = [
    '[任务栏（甲模式已开启）] 当用户要求你拆解/安排/指派开发任务时：',
    '1. 先用自然语言说明你的安排（做什么、交给谁、为什么）；',
  ]
  if (hasTool) {
    lines.push(
      '2. 然后调用 task_assign 工具逐个**发布任务到任务栏**（assignee/title/desc），一次一个任务，可连续调用多个。',
    )
  } else {
    lines.push(
      '2. 然后在回复末尾输出 JSON 数组（仅当无法调用工具时）：',
      '```json',
      '[{"assignee":"dev_1","title":"实现登录接口","desc":"补充边界与验收说明"}]',
      '```',
    )
  }
  lines.push(
    `3. 约束：assignee 必须来自可指派对象——${list}；不可捏造实例 id，也不要派给自己。`,
    '4. 发布前先看上面的 [任务栏现状]：同一受派人的同一件事不要重复发布（平台自动去重并回执）；',
    '5. 发布后平台会**通知受派人来领取**，对方 task_claim 领取后才开工——你不要承诺"已经开工"；',
    '   对方完成/受阻时平台会通知你，届时你再安排后续（验收、派新任务、发起会议）。',
    '6. 平台会给出真实登记结果，你无需虚构"已发布成功"。',
  )
  return lines.join('\n')
}
