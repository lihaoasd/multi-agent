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
import { assignTaskFromIntent } from '../task/task-dispatch.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

/** 可派单的角色（与 task-dispatch 的 DISPATCH_ROLES 保持一致）。 */
const DISPATCH_ROLES = new Set(['pm', 'product'])

export function registerServiceTools(deps: {
  memory: MemoryStore
  search: SearchService
  codeEdits: CodeEditStore
  questions?: QuestionService
  tasks?: TaskService
  listTeam?: (projectId: string) => Promise<TeamMemberConfig[]>
}): void {
  const { memory, search, codeEdits, questions, tasks, listTeam } = deps

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
}

function isVisibleTo(sessionId: string | undefined, env: { instanceId: string }): boolean {
  if (!sessionId) return false
  if (sessionId.startsWith('u_')) return sessionId === `u_${env.instanceId}`
  // meeting 会话对参会 Agent 可见（MVP 简化）
  return sessionId.startsWith('m_')
}
