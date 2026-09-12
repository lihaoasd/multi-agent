/**
 * 应用级工具注册（记忆/检索/受控编辑/用户交互类，需服务依赖），组合根启动时调用一次。
 * 只读/检索类在 user+meeting 可用；memory_append own 写入、全局仅 pm_1（D18-② 权限）。
 * workdir_edit：**项目工作目录唯一写通道**（2026-09-12 取消私有区），改动归属 taskId 聚合轨迹，
 *   并按 file-owners 做署名与归属校验（他人产出物不可改）。
 * ask_user：向用户提问/确认（单选·多选·确认·文本），仅 user 会话；用户回答后唤醒新回合。
 * task_assign：产品/项目经理发布任务到任务栏（通知受派人领取），仅 user 会话。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { registerTool } from '../../infra/tools/executor.js'
import { ensureInside } from '../../infra/file-store/fs-utils.js'
import { resolveVirtual } from '../../domain/rules/path-resolver.js'
import { MemoryStore } from '../memory/memory-store.js'
import { SearchService } from '../search/search-service.js'
import { CodeEditStore } from '../code-edit/code-edit-store.js'
import { AppError, ErrorCodes } from '../../shared/errors.js'
import type { QuestionService } from '../question/question-service.js'
import type { TaskService } from '../task/task-service.js'
import type { TaskState } from '../task/task-service.js'
import { assignTaskFromIntent } from '../task/task-dispatch.js'
import type { MeetingService } from '../meeting/meeting-service.js'
import type { ArtifactService } from '../artifact/artifact-service.js'
import type { FileOwnerStore } from '../artifact/file-owner-store.js'
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
  /** 产出物提交（项目工作目录就地登记 + 版本快照） */
  artifacts?: ArtifactService
  /** 产出物署名与归属（file-owners）：写前校验、写后认领 */
  fileOwners?: FileOwnerStore
  /** 在会议会话内为某实例执行一轮（会议发言） */
  runMeetingTurn?: (
    projectId: string,
    meetingId: string,
    instanceId: string,
    prompt: string,
  ) => Promise<void>
}): void {
  const {
    memory,
    search,
    codeEdits,
    questions,
    tasks,
    meetings,
    listTeam,
    artifacts,
    fileOwners,
    runMeetingTurn,
  } = deps

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

  // 项目工作目录受控编辑（**唯一写通道**，2026-09-12 取消私有区）
  registerTool(
    {
      name: 'workdir_edit',
      description:
        '写项目工作目录（唯一产出地；单文件、声明式替换/写入，留 diff 轨迹并署名）。' +
        '只能改自己名下的文件（见系统提示 [我的产出物]）；写他人文件会被拒，请另建新文件',
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
        return {
          ok: false,
          code: 'FS_BOUNDARY',
          reason: 'workdir_edit 仅限 workdir:// 内文件（私有区已取消，所有产出直接写项目目录）',
        }
      }
      const abs = ensureInside(env.roots.workdirRoot, r.absolute, 'relPath')
      // 归属锚点：dispatcher 注入的当前任务优先（D15）；模型自报仅作兜底
      const taskId =
        env.taskId ?? (args.taskId ? String(args.taskId) : `untracked_${env.instanceId}`)

      // 署名与归属：他人名下文件不可改（2026-09-12，用户要求"其他人不能动"）
      if (fileOwners) {
        try {
          await fileOwners.assertWritable(env.projectId, r.rel, env.instanceId)
        } catch (e) {
          return {
            ok: false,
            code: e instanceof AppError ? e.code : ErrorCodes.FORBIDDEN,
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      }

      // 逐条应用编辑（整体事务：任一步失败不改文件）
      let current = await readFile(abs, 'utf8').catch(() => '')
      const originalLength = current.length
      for (const raw of edits) {
        const e = raw as Record<string, unknown>
        // 类型推断（2026-09-12 数据安全修复）：模型常漏 type。
        // 旧实现把缺省 type 当 write、text 缺失即写空串 → **会把整文件清空**（已发生：PRD 被写成 0 字节）。
        const declared = e.type === undefined ? '' : String(e.type).trim()
        const hasText = Object.prototype.hasOwnProperty.call(e, 'text')
        const hasReplacePair =
          Object.prototype.hasOwnProperty.call(e, 'oldText') ||
          Object.prototype.hasOwnProperty.call(e, 'newText')
        const type = declared || (hasReplacePair ? 'replace' : hasText ? 'write' : '')
        if (type === 'write') {
          if (!hasText) {
            return {
              ok: false,
              code: 'ERR_VALIDATION',
              reason:
                'write 必须显式提供 text 字段：为避免误清空文件，缺少 text 的 write 一律拒绝' +
                '（想做替换请用 {type:"replace", oldText, newText}）',
            }
          }
          const text = String(e.text ?? '')
          if (text === '') {
            return {
              ok: false,
              code: 'ERR_VALIDATION',
              reason:
                '拒绝对工作目录文件写入空内容（write 的 text 不能为空）。' +
                '如确需清空，请先用 replace 删掉正文或改派任务说明意图',
            }
          }
          current = text
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
          current = current.split(oldText).join(newText)
        } else {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason:
              '每次编辑需要 type（write 全文 / replace 精确替换），或提供 text / oldText+newText 让平台推断',
          }
        }
      }
      // 回执里的"+N 字符"按真实净变化算（旧实现按写入长度累加，写空文件时会误报"无净变化"）
      const netChange = current.length - originalLength
      const changed = netChange !== 0
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, current, 'utf8')
      if (changed) {
        await codeEdits.append(env.projectId, taskId, {
          relPath: r.rel,
          editType:
            edits.length === 1 && String(edits[0]!.type ?? '') === 'write' ? 'write' : 'replace',
          changedChars: Math.abs(netChange),
        })
      }
      // 认领/续写归属（署名）
      let ownerName = env.instanceId
      if (fileOwners) {
        const team = listTeam ? await listTeam(env.projectId).catch(() => []) : []
        ownerName = team.find((m) => m.instanceId === env.instanceId)?.displayName ?? env.instanceId
        await fileOwners
          .claim(env.projectId, {
            relPath: r.rel,
            owner: env.instanceId,
            ownerName,
            taskId: env.taskId ?? null,
            via: 'workdir_edit',
          })
          .catch(() => undefined)
      }
      return {
        ok: true,
        summary:
          `已编辑 ${r.rel}（${netChange >= 0 ? '+' : ''}${netChange} 字符` +
          `｜署名 ${ownerName}（${env.instanceId}）｜归属 ${taskId}`,
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
        const sid = env.sessionId ?? `u_${env.instanceId}`
        try {
          // 软挂起：该会话已有待回答提问（常见于模型一轮里想连问几个）→ 不新建、不报错，
          // 直接结束本回合等用户回答；用户回答后模型可从历史里看到提示并继续问剩下的。
          const existing = await questions.pendingOf(env.projectId, sid).catch(() => null)
          if (existing) {
            return {
              ok: true,
              suspend: true,
              summary:
                `本轮不再新建提问：已有待回答的提问 ${existing.id}「${existing.question}」正在等用户回答` +
                '（同一会话同时只保留 1 个待答问题）。本轮到此结束：你现在处于「等待用户决策」状态，' +
                '不要继续执行任务；用户回答后你可以继续问剩下的问题（一次一个）。',
            }
          }
          const rec = await questions.ask({
            projectId: env.projectId,
            sessionId: sid,
            asker: env.instanceId,
            question: String(args.question ?? ''),
            kind: args.kind === undefined ? undefined : String(args.kind),
            options: Array.isArray(args.options) ? args.options.map(String) : undefined,
            allowText: args.allowText === true,
            // 回合内发起：等回合结束（占用释放后）再广播，避免"角色还在执行/思考，卡片已弹出"
            defer: true,
          })
          return {
            ok: true,
            // suspend：loop 见到这个标记立即结束本回合 → 角色进入「等待你处理」，不再继续执行任务
            suspend: true,
            summary:
              `已向用户提问（${rec.id}，${rec.kind}）：${rec.question}` +
              (rec.options.length ? `\n选项：${rec.options.join(' / ')}` : '') +
              '\n本轮到此结束：你现在处于「等待用户决策」状态，不要继续执行任务、也不要臆测用户答复；' +
              '用户回答后平台会唤醒你继续（还有别的要问，等这轮问答结束后再一个一个问）。',
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

  // 任务栏（2026-09-12）：pm/product 发布任务 → 平台通知受派人领取；受派人用 task_claim 领取
  if (tasks && listTeam) {
    registerTool(
      {
        name: 'task_assign',
        description:
          '把任务**发布到任务栏**并通知受派人领取（仅产品/项目经理可调用）：创建任务(state=待领取) + ' +
          '向受派人会话推送「待你领取」通知；受派人调用 task_claim 领取后才开工。' +
          '**发布前先对照系统提示里的[任务栏现状]**：同一受派人的同题任务只会保留一条（自动去重，' +
          '回执会说明与谁发布的哪条重复）；确需重复发布时用 force=true。一次调用发布一个任务，可连续调用多个',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            assignee: { type: 'string', description: '受派人实例 id（如 dev_1 / architect_1）' },
            title: { type: 'string', description: '任务标题（一句话说明要交付什么）' },
            desc: { type: 'string', description: '任务说明：产出、边界、验收要点' },
            force: {
              type: 'boolean',
              description: '强制重复发布（缺省 false：同题活跃任务自动去重，返回既有任务）',
            },
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
            reason: `只有产品/项目经理可以发布任务（当前角色 ${me?.roleTemplateId ?? env.instanceId}）`,
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
            force: args.force === true,
          },
        )
        if (!r.ok) {
          return { ok: false, code: 'ERR_CONFLICT', reason: r.reason ?? '发布失败' }
        }
        if (r.duplicate) {
          return {
            ok: true,
            summary:
              `未重复创建：「${r.title}」→ ${r.assignee} 已有同题任务 ${r.taskId}` +
              `（由 ${r.existingCreator ?? '他人'} 发布，状态 ${r.state ?? 'todo'}）。` +
              '如需在同一任务上补充说明，请在会话中与发布者对账；确需再派一条时用 force=true',
          }
        }
        return {
          ok: true,
          summary:
            `已发布任务 ${r.taskId}「${r.title}」到任务栏 → ${r.assignee}` +
            `（待领取；已通知 ${r.assignee} 领取）`,
        }
      },
    )

    // 领取任务：todo → in_progress，只能领自己名下的
    registerTool(
      {
        name: 'task_claim',
        description:
          '领取任务栏上派给你的任务（state: 待领取 → 进行中）：缺省领取最早的一条。' +
          '领取后你才开始执行；手上有进行中任务时会被拒绝。完成后用 task_update(state=done) 上报',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 id；缺省=领取我最早的一条待领取任务' },
          },
        },
      },
      async (args, env) => {
        const taskId = args.taskId === undefined ? '' : String(args.taskId).trim()
        try {
          const rec = await tasks.claim(env.projectId, env.instanceId, taskId || undefined)
          return {
            ok: true,
            summary:
              `已领取任务 ${rec.id}「${rec.title}」→ 进行中（in_progress）` +
              (rec.desc ? `；任务说明：${rec.desc.slice(0, 200)}` : '') +
              '。完成后必须调用 task_update(state=done, note=一句话完成总结)，' +
              '并在回复里给用户一段完成总结（做了什么/产出文件/验证结果/遗留）',
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

  // 任务状态自管：受派者自己汇报 开工/完成/受阻/终止（默认作用于当前激活任务）
  if (tasks) {
    registerTool(
      {
        name: 'task_update',
        description:
          '更新任务状态（默认作用于你当前的进行中任务）：in_progress 开工 / done 完成 / blocked 受阻 / todo 回队 / terminated 终止。' +
          '**完成时务必带 note=一句话完成总结**（做了什么/产出文件/验证结果/遗留），平台会更新任务栏、' +
          '把总结通知委派人，并在会话里作为完成总结展示给用户',
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
            note: { type: 'string', description: '说明：done 时为完成总结；blocked 时为受阻原因' },
          },
          required: ['state'],
        },
      },
      async (args, env) => {
        const wanted = args.taskId === undefined ? '' : String(args.taskId).trim()
        const note = args.note === undefined ? undefined : String(args.note)
        const myTasks = await tasks.list(env.projectId, { assignee: env.instanceId })
        // 默认任务：显式 taskId > 当前进行中（dispatcher 注入）委托 > 我的最旧待领取（补领取后完成）
        let taskId = wanted || env.taskId || ''
        let autoClaimed = false
        if (!taskId) {
          const active = myTasks.find((t) => t.state === 'in_progress')
          const queued = myTasks
            .filter((t) => t.state === 'todo')
            .sort((a, b) => (a.ts < b.ts ? -1 : 1))[0]
          if (active) taskId = active.id
          else if (queued) taskId = queued.id
        }
        if (!taskId) {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason: '未指定 taskId，且当前没有进行中/待领取的任务（请先由协调者派单）',
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
          // 角色没先 claim 就直接上报（常见：做完才想起来）→ 先补领取再流转
          const before = myTasks.find((t) => t.id === taskId)
          if (before && before.state === 'todo' && before.assignee === env.instanceId) {
            await tasks.claim(env.projectId, env.instanceId, taskId)
            autoClaimed = true
          }
          const rec = await tasks.setState(env.projectId, taskId, state, env.instanceId, note)
          const zh: Record<string, string> = {
            todo: '待领取',
            in_progress: '进行中',
            done: '已完成',
            blocked: '受阻',
            terminated: '已终止',
          }
          return {
            ok: true,
            summary:
              `任务 ${rec.id}「${rec.title}」状态 → ${zh[rec.state] ?? rec.state}` +
              (autoClaimed ? '（此前未领取，已自动补领取）' : '') +
              (rec.state === 'done'
                ? note?.trim()
                  ? `；完成总结已记录并通知委派人：${note.trim().slice(0, 120)}`
                  : '；**未提供完成总结**：请在回复里给用户一段总结（做了什么/产出文件/验证结果）'
                : ''),
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
  // 产出物提交（交付通道②，workspaces-artifacts §2.1）：私有区定稿 → 项目工作目录 + 版本快照
  if (artifacts) {
    registerTool(
      {
        name: 'artifact_submit',
        description:
          '把你的产出**登记为产出物**：为工作目录里已写好的文件建一条产出物记录 + 版本快照 + 署名' +
          '（不移动文件；产出物本来就在项目目录里）。只能登记自己名下的文件',
        scope: 'platform',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '产出物标题（如「登录模块 PRD」）' },
            type: {
              type: 'string',
              enum: ['doc', 'code', 'config', 'test', 'deploy'],
              description: '产出物类型，缺省 doc',
            },
            summary: { type: 'string', description: '一句话说明（可选）' },
            files: {
              type: 'array',
              description: '要登记的产出物文件：relPath = 项目工作目录内的相对路径',
              items: {
                type: 'object',
                properties: {
                  relPath: { type: 'string', description: '如 docs/prd.md' },
                  fromWsRel: {
                    type: 'string',
                    description: '（已废弃）旧私有区路径；私有区已取消，请用 relPath',
                  },
                },
                required: ['relPath'],
              },
            },
            path: {
              type: 'string',
              description: '单文件简写：工作目录相对路径（等价 files=[{relPath:path}]）',
            },
            relPath: { type: 'string', description: '单文件简写：工作目录相对路径' },
          },
          required: ['title'],
        },
      },
      async (args, env) => {
        const title = String(args.title ?? '').trim()
        if (!title) return { ok: false, code: 'ERR_VALIDATION', reason: 'title 必填' }
        const type = String(args.type ?? 'doc').trim()
        if (!['doc', 'code', 'config', 'test', 'deploy'].includes(type)) {
          return { ok: false, code: 'ERR_VALIDATION', reason: `不支持的产出物类型: ${type}` }
        }
        const rawFiles = Array.isArray(args.files) ? args.files : []
        const list: Array<{ fromWsRel: string; relPath: string }> = []
        for (const f of rawFiles) {
          if (typeof f !== 'object' || f === null) continue
          const row = f as Record<string, unknown>
          const relRaw = String(row.relPath ?? '').trim()
          const legacy = String(row.fromWsRel ?? '').trim()
          // 私有区已取消：新调用只认 relPath；历史 fromWsRel 仅作兼容
          const relPath = relRaw || stripWs(legacy)
          if (!relPath) continue
          list.push({ fromWsRel: legacy || `workdir://${relPath}`, relPath })
        }
        if (!list.length && (args.path || args.relPath)) {
          const relPath =
            String(args.relPath ?? '').trim() || stripWs(String(args.path ?? '').trim())
          if (relPath) list.push({ fromWsRel: `workdir://${relPath}`, relPath })
        }
        if (!list.length) {
          return {
            ok: false,
            code: 'ERR_VALIDATION',
            reason: 'files 不能为空（或提供 path/relPath 单文件简写）',
          }
        }
        // 署名与归属：不能把他人产出物登记/覆盖成自己的
        if (fileOwners) {
          for (const f of list) {
            try {
              await fileOwners.assertWritable(env.projectId, f.relPath, env.instanceId)
            } catch (e) {
              return {
                ok: false,
                code: e instanceof AppError ? e.code : ErrorCodes.FORBIDDEN,
                reason: e instanceof Error ? e.message : String(e),
              }
            }
          }
        }
        // 产出物提交**不走审批门**（用户要求，2026-09-09）
        const needsApproval = false
        try {
          const { record } = await artifacts.submit({
            projectId: env.projectId,
            actor: env.instanceId,
            sessionId: env.sessionId,
            taskId: env.taskId ?? null,
            type: type as never,
            title,
            summary: args.summary === undefined ? '' : String(args.summary),
            files: list,
            needsApproval,
          })
          let ownerName = env.instanceId
          if (fileOwners) {
            const team = listTeam ? await listTeam(env.projectId).catch(() => []) : []
            ownerName =
              team.find((m) => m.instanceId === env.instanceId)?.displayName ?? env.instanceId
            for (const f of list) {
              await fileOwners
                .claim(env.projectId, {
                  relPath: f.relPath,
                  owner: env.instanceId,
                  ownerName,
                  taskId: env.taskId ?? null,
                  via: 'artifact_submit',
                })
                .catch(() => undefined)
            }
          }
          const where = list.map((f) => f.relPath).join('、')
          return {
            ok: true,
            summary:
              `已登记产出物 ${record.id}「${title}」v${record.version} → ${where}` +
              `｜署名 ${ownerName}（${env.instanceId}）｜版本快照已存`,
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
}

/** ws://docs/a.md → docs/a.md（提交到项目目录时的默认相对路径）。 */
function stripWs(p: string): string {
  return p.replace(/^ws:\/\//, '').replace(/^[/\\]+/, '')
}

function isVisibleTo(sessionId: string | undefined, env: { instanceId: string }): boolean {
  if (!sessionId) return false
  if (sessionId.startsWith('u_')) return sessionId === `u_${env.instanceId}`
  // meeting 会话对参会 Agent 可见（MVP 简化）
  return sessionId.startsWith('m_')
}
