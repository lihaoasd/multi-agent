import { registerTool } from '../../../infra/tools/executor.js'
import type { ServiceToolDeps } from './context.js'
import type { TaskState } from '../../task/task-service.js'
import { TASK_STATES as ALL_TASK_STATES } from '../../../domain/fsm/task-state.js'
import { assignTaskFromIntent } from '../../task/task-dispatch.js'

/** 可派单的角色（与 task-dispatch 的 DISPATCH_ROLES 保持一致）。 */
const DISPATCH_ROLES = new Set(['pm', 'product'])
/** 任务状态全集（task_update 校验用） */
const TASK_STATES: TaskState[] = [...ALL_TASK_STATES]

/** 任务栏工具：`task_assign`（发布，仅 user 会话）/ `task_claim`（领取）/ `task_update`（自报状态）。 */
export function registerTaskTools(deps: ServiceToolDeps): void {
  const { tasks, listTeam } = deps
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
  }

  if (tasks) {
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
}
