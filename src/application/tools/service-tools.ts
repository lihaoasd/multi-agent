/**
 * 应用级工具注册（记忆/检索/受控编辑/用户交互类，需服务依赖），组合根启动时调用一次。
 * 只读/检索类在 user+meeting 可用；memory_append own 写入、全局仅 pm_1（D18-② 权限）。
 * workdir_edit：code 受控编辑（写通道①，D14-⑧），仅 user 会话，改动归属 taskId 聚合轨迹。
 * ask_user：向用户提问/确认（单选·多选·确认·文本），仅 user 会话；用户回答后唤醒新回合。
 * task_assign：产品/项目经理给团队成员派单（创建任务 + 默认立即开工），仅 user 会话。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { registerTool } from '../../infra/tools/executor.js'
import { ensureInside } from '../../infra/file-store/fs-utils.js'
import { resolveVirtual } from '../../domain/rules/path-resolver.js'
import { MemoryStore } from '../memory/memory-store.js'
import { SearchService } from '../search/search-service.js'
import { CodeEditStore } from '../code-edit/code-edit-store.js'
import type { QuestionService } from '../question/question-service.js'
import type { TaskService } from '../task/task-service.js'
import type { TaskState } from '../task/task-service.js'
import { assignTaskFromIntent } from '../task/task-dispatch.js'
import type { MeetingService } from '../meeting/meeting-service.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

/** 可派单的角色（与 task-dispatch 的 DISPATCH_ROLES 保持一致）。 */
const DISPATCH_ROLES = new Set(['pm', 'product'])
/** 任务状态全集（task_update 校验用） */
const TASK_STATES: TaskState[] = ['todo', 'in_progress', 'done', 'blocked', 'terminated']

export function registerServiceTools(deps: {
  memory: MemoryStore
  search: SearchService
  codeEdits: CodeEditStore
  questions?: QuestionService
  tasks?: TaskService
  meetings?: MeetingService
  listTeam?: (projectId: string) => Promise<TeamMemberConfig[]>
  /** 在会议会话内为某实例执行一轮（会议发言） */
  runMeetingTurn?: (
    projectId: string,
    meetingId: string,
    instanceId: string,
    prompt: string,
  ) => Promise<void>
}): void {
  const { memory, search, codeEdits, questions, tasks, meetings, listTeam, runMeetingTurn } = deps

  registerTool(
    {
      name: 'memory_append',
      description: '追加长期记忆条目（scope=own 默认；全局写仅 pm）',
      scope: 'workspace',
      availableIn: ['user', 'meeting'],
      idempotent: true,
      paramsSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '记忆内容' },
          type: { type: 'string', description: 'fact|decision|preference|meeting_summary 等' },
          scope: { type: 'string', enum: ['own', 'global'], description: '缺省 own' },
        },
        required: ['content'],
      },
    },
    async (args, env) => {
      const content = String(args.content ?? '').trim()
      if (!content) return { ok: false, code: 'ERR_VALIDATION', reason: 'content 必填' }
      const type = (args.type as string) || 'fact'
      const scope = args.scope === 'global' ? 'global' : 'role'
      if (scope === 'global' && env.instanceId !== 'pm_1') {
        return {
          ok: false,
          code: 'ERR_TOOL_REJECTED',
          reason: '全局记忆写入仅 PM（决策/会议结论由引擎登记）',
        }
      }
      const entry = await memory.append(
        env.projectId,
        {
          type: type as never,
          content,
          source: { sessionId: null, seq: null },
          tags: [],
          refs: [],
        },
        scope,
        scope === 'role' ? env.instanceId : undefined,
      )
      return { ok: true, summary: `已写入${scope === 'global' ? '全局' : '个人'}记忆 ${entry.id}` }
    },
  )

  registerTool(
    {
      name: 'memory_search',
      description: '检索记忆（角色+全局）',
      scope: 'readonly-global',
      availableIn: ['user', 'meeting'],
      idempotent: true,
      paramsSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: '检索关键词' } },
        required: ['q'],
      },
    },
    async (args, env) => {
      const q = String(args.q ?? '').trim()
      if (!q) return { ok: false, code: 'ERR_VALIDATION', reason: 'q 必填' }
      const r = await search.search(env.projectId, q)
      const mem = r.memories.map((m) => m.snippet).slice(0, 5)
      return { ok: true, summary: mem.length ? mem.join('\n') : '(无记忆命中)' }
    },
  )

  registerTool(
    {
      name: 'session_search',
      description: '检索本项目会话日志',
      scope: 'readonly-global',
      availableIn: ['user', 'meeting'],
      idempotent: true,
      paramsSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: '检索关键词' } },
        required: ['q'],
      },
    },
    async (args, env) => {
      const q = String(args.q ?? '').trim()
      if (!q) return { ok: false, code: 'ERR_VALIDATION', reason: 'q 必填' }
      const res = await search.search(env.projectId, q)
      const lines: string[] = []
      for (const s of res.sessions) {
        if (!isVisibleTo(s.sessionId, env)) continue
        for (const h of s.hits.slice(0, 3)) lines.push(`${s.sessionId}:${h.snippet}`)
      }
      return { ok: true, summary: lines.length ? lines.join('\n') : '(无会话命中或无权查看)' }
    },
  )

  // code 受控编辑（写工作目录通道①，workspaces-artifacts §2.2 / tools.md §6）
  registerTool(
    {
      name: 'workdir_edit',
      description: '工作目录受控编辑（单文件、声明式替换/写入，留 diff 轨迹；归属 taskId）',
      scope: 'workdir',
      availableIn: ['user'],
      idempotent: false,
      paramsSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作目录内虚拟路径，如 workdir://src/a.ts' },
          edits: {
            type: 'array',
            description: '按顺序应用的编辑；write 覆盖全文，replace 做精确替换',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['write', 'replace'] },
                text: { type: 'string', description: 'type=write 时的全文' },
                oldText: { type: 'string', description: 'type=replace 时的被替换文本' },
                newText: { type: 'string', description: 'type=replace 时的替换文本' },
              },
              required: ['type'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    async (args, env) => {
      const path = String(args.path ?? '')
      const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : []
      if (!path || edits.length === 0) {
        return { ok: false, code: 'ERR_VALIDATION', reason: 'path 与 edits 必填' }
      }
      const r = resolveVirtual(path, env.roots)
      if (r.scheme !== 'workdir') {
        return { ok: false, code: 'FS_BOUNDARY', reason: 'workdir_edit 仅限 workdir:// 内文件' }
      }
      const abs = ensureInside(env.roots.workdirRoot, r.absolute, 'relPath')
      // 归属锚点：dispatcher 注入的当前任务优先（D15）；模型自报仅作兜底
      const taskId =
        env.taskId ?? (args.taskId ? String(args.taskId) : `untracked_${env.instanceId}`)

      // 逐条应用编辑（整体事务：任一步失败不改文件）
      let current = await readFile(abs, 'utf8').catch(() => '')
      let changedChars = 0
      for (const e of edits) {
        const type = String(e.type ?? 'write')
        if (type === 'write') {
          current = String(e.text ?? '')
          changedChars += current.length
        } else if (type === 'replace') {
          const oldText = String(e.oldText ?? '')
          const newText = String(e.newText ?? '')
          if (oldText === '')
            return { ok: false, code: 'ERR_VALIDATION', reason: 'replace 需 oldText' }
          if (!current.includes(oldText)) {
            return {
              ok: false,
              code: 'ERR_CONFLICT',
              reason: `替换目标不存在（文件已被外部修改?）：${JSON.stringify(oldText.slice(0, 60))}`,
            }
          }
          changedChars += Math.abs(newText.length - oldText.length)
          current = current.split(oldText).join(newText)
        } else {
          return { ok: false, code: 'ERR_VALIDATION', reason: `不支持编辑类型: ${type}` }
        }
      }
      const changed = changedChars > 0
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, current, 'utf8')
      if (changed) {
        await codeEdits.append(env.projectId, taskId, {
          relPath: r.rel,
          editType:
            edits.length === 1 && String(edits[0]!.type ?? '') === 'write' ? 'write' : 'replace',
          changedChars,
        })
      }
      return {
        ok: true,
        summary: `已编辑 ${r.rel}${changed ? `（+${changedChars} 字符，归属 ${taskId}）` : '（无净变化）'}`,
      }
    },
  )

  // 用户询问/确认（单选·多选·确认·文本）：落 pending 提问，用户在会话内卡片回答后唤醒新回合
  if (questions) {
    registerTool(
      {
        name: 'ask_user',
        description:
          '向用户（老板）提问/请求确认：kind=confirm 确认、single 单选、multi 多选、text 自由文本；' +
          '当你需要用户拍板、选择方案或补充信息时使用，不要替用户决定',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问用户的问题（清晰、可回答）' },
            kind: {
              type: 'string',
              enum: ['confirm', 'single', 'multi', 'text'],
              description: '交互形式，缺省 confirm（确认/取消）',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'single/multi 必填（≥2 项）；confirm 缺省「确认/取消」',
            },
            allowText: { type: 'boolean', description: '是否允许用户附加补充说明' },
          },
          required: ['question'],
        },
      },
      async (args, env) => {
        try {
          const rec = await questions.ask({
            projectId: env.projectId,
            sessionId: env.sessionId ?? `u_${env.instanceId}`,
            asker: env.instanceId,
            question: String(args.question ?? ''),
            kind: args.kind === undefined ? undefined : String(args.kind),
            options: Array.isArray(args.options) ? args.options.map(String) : undefined,
            allowText: args.allowText === true,
          })
          return {
            ok: true,
            summary:
              `已向用户提问（${rec.id}，${rec.kind}）：${rec.question}` +
              (rec.options.length ? `\n选项：${rec.options.join(' / ')}` : '') +
              '\n请结束本轮并等待用户在会话中回答；不要臆测用户的答复。',
          }
        } catch (e) {
          return {
            ok: false,
            code:
              e instanceof Error && 'code' in e
                ? String((e as { code: string }).code)
                : 'ERR_TOOL_REJECTED',
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    )
  }

  // 派单（甲模式）：产品/项目经理给团队成员创建任务并默认立即开工（受派者空闲时自动唤醒）
  if (tasks && listTeam) {
    registerTool(
      {
        name: 'task_assign',
        description:
          '给团队成员派发任务（仅产品/项目经理可调用）：创建任务并默认让对方立即开工；' +
          '受派者已有进行中任务时自动排队为 todo。一次调用派一个任务，可连续调用多个',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            assignee: { type: 'string', description: '受派者实例 id（如 dev_1 / architect_1）' },
            title: { type: 'string', description: '任务标题（一句话说明要交付什么）' },
            desc: { type: 'string', description: '任务说明：产出、边界、验收要点' },
            start: { type: 'boolean', description: '是否立即开工，缺省 true' },
          },
          required: ['assignee', 'title'],
        },
      },
      async (args, env) => {
        const team = await listTeam(env.projectId)
        const me = team.find((m) => m.instanceId === env.instanceId)
        if (!me || !DISPATCH_ROLES.has(me.roleTemplateId)) {
          return {
            ok: false,
            code: 'ERR_TOOL_REJECTED',
            reason: `只有产品/项目经理可以派单（当前角色 ${me?.roleTemplateId ?? env.instanceId}）`,
          }
        }
        const assignee = String(args.assignee ?? '').trim()
        const title = String(args.title ?? '').trim()
        if (!assignee || !title) {
          return { ok: false, code: 'ERR_VALIDATION', reason: 'assignee/title 必填' }
        }
        const r = await assignTaskFromIntent(
          {
            projectId: env.projectId,
            actorId: env.instanceId,
            team,
            tasks,
            emitTool: async () => undefined, // 工具调用本身已由工具循环记审计事件
          },
          {
            assignee,
            title,
            desc: args.desc === undefined ? undefined : String(args.desc),
            start: args.start !== false,
          },
        )
        if (!r.ok) {
          return { ok: false, code: 'ERR_CONFLICT', reason: r.reason ?? '派发失败' }
        }
        return {
          ok: true,
          summary:
            r.state === 'in_progress'
              ? `已创建任务 ${r.taskId}「${r.title}」→ ${r.assignee}（已开始执行）`
              : `已创建任务 ${r.taskId}「${r.title}」→ ${r.assignee}（已排队 todo：${r.reason ?? '等待开工'}）`,
        }
      },
    )
  }

  // 任务状态自管：受派者自己汇报 开工/完成/受阻/终止（默认作用于当前激活任务）
  if (tasks) {
    registerTool(
      {
        name: 'task_update',
        description:
          '更新任务状态（默认作用于你当前的进行中任务）：in_progress 开工 / done 完成 / blocked 受阻 / todo 回队 / terminated 终止。' +
          '完成后请调用本工具把状态改为 done 再汇报',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 id；缺省用你当前进行中的任务' },
            state: {
              type: 'string',
              enum: ['todo', 'in_progress', 'done', 'blocked', 'terminated'],
              description: '目标状态',
            },
            note: { type: 'string', description: '可选说明（写入会话汇报用）' },
          },
          required: ['state'],
        },
      },
      async (args, env) => {
        const taskId =
          (args.taskId === undefined ? '' : String(args.taskId).trim()) || env.taskId || ''
        if (!taskId) {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason: '未指定 taskId，且当前没有进行中的任务（请先由协调者派单）',
          }
        }
        const state = String(args.state ?? '').trim() as TaskState
        if (!TASK_STATES.includes(state)) {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason: `state 必须是 ${TASK_STATES.join('|')}`,
          }
        }
        try {
          const rec = await tasks.setState(env.projectId, taskId, state, env.instanceId)
          return { ok: true, summary: `任务 ${rec.id}「${rec.title}」状态 → ${rec.state}` }
        } catch (e) {
          return {
            ok: false,
            code:
              e instanceof Error && 'code' in e
                ? String((e as { code: string }).code)
                : 'ERR_CONFLICT',
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    )
  }

  // 发起/结束会议：任意角色都可发起（平台代受邀 AI 成员接受）；仅主持人可结束
  if (meetings && listTeam) {
    registerTool(
      {
        name: 'meeting_start',
        description:
          '发起会议（任意角色）：给定主题、描述与参会人（不含自己）；平台会代受邀 AI 成员接受并进入会议，用户可插话/拍板/结束',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '会议主题' },
            desc: { type: 'string', description: '会议描述：为什么开、期望产出' },
            members: {
              type: 'array',
              items: { type: 'string' },
              description: '参会角色实例 id（如 dev_1、qa_1；不含自己）',
            },
            agenda: { type: 'array', items: { type: 'string' }, description: '议题（可选）' },
          },
          required: ['topic', 'members'],
        },
      },
      async (args, env) => {
        const topic = String(args.topic ?? '').trim()
        const desc = args.desc === undefined ? '' : String(args.desc).trim()
        const members = (Array.isArray(args.members) ? args.members.map(String) : [])
          .map((s) => s.trim())
          .filter(Boolean)
        const agenda = (Array.isArray(args.agenda) ? args.agenda.map(String) : [])
          .map((s) => s.trim())
          .filter(Boolean)
        if (!topic) return { ok: false, code: 'ERR_VALIDATION', reason: 'topic 必填' }
        if (!members.length)
          return { ok: false, code: 'ERR_VALIDATION', reason: 'members 至少 1 人' }
        if (members.includes(env.instanceId)) {
          return { ok: false, code: 'ERR_VALIDATION', reason: '你是主持人，members 不要包含自己' }
        }
        const team = await listTeam(env.projectId)
        const enabled = team.filter((m) => m.enabled).map((m) => m.instanceId)
        const bad = members.filter((m) => !enabled.includes(m))
        if (bad.length) {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason: `实例不存在或已停用：${bad.join('、')}（可选：${enabled.join('、')}）`,
          }
        }
        try {
          const rec = await meetings.create({
            projectId: env.projectId,
            host: env.instanceId,
            topic,
            desc,
            agenda,
            members,
          })
          // 平台代受邀 AI 成员接受邀请 → 会议进入 open（占用=会议中）
          for (const m of members) {
            await meetings.respond(env.projectId, rec.id, m, 'accept').catch(() => undefined)
          }
          // 让会议真正"开起来"：主持人开场 → 依次请成员发言 → 主持人收尾（后台串行，不阻塞本回合）
          if (runMeetingTurn) {
            const hostOpen =
              `【会议开场】你是主持人（${env.instanceId}）。会议主题「${topic}」` +
              (desc ? `，描述：${desc}` : '') +
              `，参会：${members.join('、')} 与用户。请先开场：说明议题与期望产出；` +
              '然后可用 meeting_talk 逐个点名成员发言（他们的发言会写进会议会话）。'
            const hostWrap =
              `【会议收尾】会议「${topic}」的成员发言已写入会议会话。请阅读后给出：结论、待办（谁做什么）、` +
              '仍需用户拍板的事项；如需结束会议可调用 meeting_close。'
            void (async () => {
              await runMeetingTurn(env.projectId, rec.id, env.instanceId, hostOpen).catch(
                () => undefined,
              )
              for (const m of members) {
                const p =
                  `【会议邀请】${env.instanceId} 邀请你参加「${topic}」` +
                  (desc ? `（${desc}）` : '') +
                  '。请在会议中发表意见：结论 + 理由 + 需要谁配合（简明，不要复述别人）。'
                await runMeetingTurn(env.projectId, rec.id, m, p).catch(() => undefined)
              }
              await runMeetingTurn(env.projectId, rec.id, env.instanceId, hostWrap).catch(
                () => undefined,
              )
              // 结论产出后由发起人结束会议（平台代收尾 → 生成纪要）
              const cur = (await meetings.list(env.projectId)).find((m) => m.id === rec.id)
              if (cur && (cur.state === 'open' || cur.state === 'blocked_waiting_user')) {
                await meetings.close(env.projectId, rec.id, env.instanceId).catch(() => undefined)
              }
            })().catch(() => undefined)
          }
          return {
            ok: true,
            summary:
              `已发起会议 ${rec.id}「${topic}」，参会：我（${env.instanceId}，主持）、${members.join('、')}、用户。` +
              '会议已开始；请在会议会话中跟进结论，结束后用 meeting_close 收尾（会生成纪要）。',
          }
        } catch (e) {
          return {
            ok: false,
            code:
              e instanceof Error && 'code' in e
                ? String((e as { code: string }).code)
                : 'ERR_CONFLICT',
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    )

    registerTool(
      {
        name: 'meeting_close',
        description: '结束你主持的会议并生成纪要（仅主持人）',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: { meetingId: { type: 'string', description: '会议 id（m_…）' } },
          required: ['meetingId'],
        },
      },
      async (args, env) => {
        const meetingId = String(args.meetingId ?? '').trim()
        if (!meetingId) return { ok: false, code: 'ERR_VALIDATION', reason: 'meetingId 必填' }
        try {
          const rec = (await meetings.list(env.projectId)).find((m) => m.id === meetingId)
          if (!rec) return { ok: false, code: 'ERR_NOT_FOUND', reason: `会议不存在: ${meetingId}` }
          if (rec.meeting.host !== env.instanceId) {
            return { ok: false, code: 'ERR_TOOL_REJECTED', reason: '只有主持人才可以结束会议' }
          }
          await meetings.close(env.projectId, meetingId, env.instanceId)
          return { ok: true, summary: `已结束会议 ${meetingId}，纪要已生成` }
        } catch (e) {
          return {
            ok: false,
            code:
              e instanceof Error && 'code' in e
                ? String((e as { code: string }).code)
                : 'ERR_CONFLICT',
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    )

    // 主持人点名某位参会成员在会议中发言（触发其在会议会话里发言）
    registerTool(
      {
        name: 'meeting_talk',
        description:
          '主持人点名某位参会成员在会议中发言：会触发该成员在会议会话里发言（发言写入会议记录）',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            meetingId: { type: 'string', description: '会议 id（m_…）' },
            member: { type: 'string', description: '被点名的参会成员实例 id（不能是自己）' },
            question: { type: 'string', description: '可选：请他就某个具体问题表态' },
          },
          required: ['meetingId', 'member'],
        },
      },
      async (args, env) => {
        const meetingId = String(args.meetingId ?? '').trim()
        const member = String(args.member ?? '').trim()
        if (!meetingId || !member) {
          return { ok: false, code: 'ERR_VALIDATION', reason: 'meetingId/member 必填' }
        }
        try {
          await meetings.speakTurn(
            env.projectId,
            meetingId,
            env.instanceId,
            member,
            args.question === undefined ? undefined : String(args.question),
          )
          return {
            ok: true,
            summary: `已邀请 ${member} 在会议 ${meetingId} 发言（发言将写入会议会话）`,
          }
        } catch (e) {
          return {
            ok: false,
            code:
              e instanceof Error && 'code' in e
                ? String((e as { code: string }).code)
                : 'ERR_CONFLICT',
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    )
  }
}

function isVisibleTo(sessionId: string | undefined, env: { instanceId: string }): boolean {
  if (!sessionId) return false
  if (sessionId.startsWith('u_')) return sessionId === `u_${env.instanceId}`
  // meeting 会话对参会 Agent 可见（MVP 简化）
  return sessionId.startsWith('m_')
}
