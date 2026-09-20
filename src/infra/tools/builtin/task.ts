import type { TaskService } from '../../../ports/task'
import type { TaskState } from '../../../shared/artifacts'
import { TASK_STATES } from '../../../shared/artifacts'
import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'

/**
 * 任务工具（data-storage §7、D19-⑤）：
 * `task_view`/`task_list`（看）/ `task_assign`（委派，受编排图出边约束——边校验在 S7 接入，
 * 本轮先记录 creator 并按任务闭环流转）/ `task_claim`（领取）/ `task_update`（汇报 done/terminated）。
 * S53：任务不再有「受阻」状态；汇报/领取的结果里会带上名下剩余任务，推动角色主动续领。
 */

const SESSION_USER_ONLY = ['user'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function describe(task: {
  readonly id: string
  readonly title: string
  readonly state: string
  readonly assignee: string
  readonly creator: string
  readonly desc: string
  readonly note: string | null
}): string {
  return `#${task.id} [${task.state}] ${task.title}（受派：${task.assignee}｜发起：${task.creator}）${task.desc.length > 0 ? `\n  说明：${task.desc}` : ''}${task.note === null ? '' : `\n  备注：${task.note}`}`
}

export interface TaskToolDeps {
  readonly tasks: TaskService
}

export function taskViewTool(deps: TaskToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'task_view',
      package: 'task',
      description: '查看某条任务的详情（状态、受派人、发起人、说明与备注）',
      paramsSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务 id，如 t_xxx' } },
        required: ['taskId'],
      },
      scope: 'platform',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 4_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const taskId = readString(asRecord(input), 'taskId')
      if (taskId === undefined) return { ok: false, text: '缺少 taskId', errorCode: 'ERR_VALIDATION' }
      const found = await deps.tasks.get(context.projectId, taskId)
      if (!found.ok) return { ok: false, text: found.error.message, errorCode: found.error.code }
      return { ok: true, text: describe(found.value), data: { task: found.value } }
    },
  }
}

export function taskListTool(deps: TaskToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'task_list',
      package: 'task',
      description: '列出项目任务（可按状态筛）；mime=own 只看派给自己的任务',
      paramsSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: [...TASK_STATES], description: '按状态过滤' },
          mine: { type: 'boolean', description: '只看派给自己的任务（默认 true）' },
        },
        required: [],
      },
      scope: 'platform',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 4_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const state = readString(record, 'state')
      if (state !== undefined && !(TASK_STATES as readonly string[]).includes(state)) {
        return { ok: false, text: `未知任务状态：${state}`, errorCode: 'ERR_VALIDATION' }
      }
      const mine = record?.['mine'] !== false
      const listed = await deps.tasks.list(context.projectId, {
        ...(state === undefined ? {} : { state: state as TaskState }),
        ...(mine ? { assignee: context.instanceId } : {}),
      })
      if (!listed.ok) return { ok: false, text: listed.error.message, errorCode: listed.error.code }
      if (listed.value.length === 0) return { ok: true, text: mine ? '你当前没有任务。' : '项目里还没有任务。' }
      return {
        ok: true,
        text: listed.value.map((task) => describe(task)).join('\n'),
        data: { count: listed.value.length },
      }
    },
  }
}

export function taskAssignTool(deps: TaskToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'task_assign',
      package: 'task',
      description:
        '把一项工作派给项目里的另一个角色（创建任务并入 todo，被派人会收到通知）。只能沿编排图出边派单（越边会被拒绝）。',
      paramsSchema: {
        type: 'object',
        properties: {
          assignee: { type: 'string', description: '受派人 instanceId，如 qa_1' },
          title: { type: 'string', description: '任务标题（短）' },
          desc: { type: 'string', description: '任务说明（验收标准、产出要求）' },
          force: { type: 'boolean', description: '同受派人存在活跃同题任务时是否强制新建（默认 false）' },
        },
        required: ['assignee', 'title'],
      },
      scope: 'platform',
      risk: 'low',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 2_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const assignee = readString(record, 'assignee')
      const title = readString(record, 'title')
      if (assignee === undefined || title === undefined) {
        return { ok: false, text: '缺少 assignee 或 title', errorCode: 'ERR_VALIDATION' }
      }
      const created = await deps.tasks.create({
        projectId: context.projectId,
        title,
        desc: readString(record, 'desc') ?? '',
        creator: context.instanceId,
        assignee,
        sessionId: `u_${assignee}`,
        ...(record?.['force'] === true ? { force: true } : {}),
      })
      if (!created.ok) return { ok: false, text: created.error.message, errorCode: created.error.code }
      return {
        ok: true,
        text: created.value.duplicate
          ? `该受派人已有活跃同题任务，未重复新建：#${created.value.task.id}「${created.value.task.title}」`
          : `已派单 #${created.value.task.id}「${created.value.task.title}」给 ${assignee}（todo，待领取）`,
        data: { taskId: created.value.task.id, duplicate: created.value.duplicate },
      }
    },
  }
}

export function taskClaimTool(deps: TaskToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'task_claim',
      package: 'task',
      description: '领取派给自己的任务（todo → in_progress）。同一时刻只能有一个进行中的任务。',
      paramsSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务 id' } },
        required: ['taskId'],
      },
      scope: 'platform',
      risk: 'low',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 1_500, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const taskId = readString(asRecord(input), 'taskId')
      if (taskId === undefined) return { ok: false, text: '缺少 taskId', errorCode: 'ERR_VALIDATION' }
      const claimed = await deps.tasks.claim(context.projectId, taskId, context.instanceId)
      if (!claimed.ok) return { ok: false, text: claimed.error.message, errorCode: claimed.error.code }
      return {
        ok: true,
        text: `已领取任务：${describe(claimed.value)}${await remainingTodoHint(deps, context.projectId, context.instanceId)}`,
        data: { task: claimed.value },
      }
    },
  }
}

/**
 * 汇报完一条任务后，附带提醒名下还没做完的任务（S53-②）：角色不能只等唤醒，
 * 每完成一条就要自己回头看任务列表并继续领取。
 */
async function pendingHint(deps: TaskToolDeps, projectId: string, instanceId: string): Promise<string> {
  const listed = await deps.tasks.list(projectId, { assignee: instanceId })
  if (!listed.ok) return ''
  const pending = listed.value.filter((task) => task.state === 'todo' || task.state === 'in_progress')
  if (pending.length === 0) return '\n你名下已没有未完成任务。'
  const lines = pending.map((task) => `  #${task.id} [${task.state}] ${task.title}`).join('\n')
  const claimable = pending.filter((task) => task.state === 'todo').length
  return `\n你名下还有 ${pending.length} 条未完成任务：\n${lines}\n不要等唤醒：${claimable === 0 ? '请直接用 task_list 复核全项目任务，看是否有需要你接手的工作。' : '请立即用 task_claim 领取 todo 中的任务继续推进。'}`
}

/** 领取成功后提醒名下还有多少条待领取任务（S53-②）。 */
async function remainingTodoHint(deps: TaskToolDeps, projectId: string, instanceId: string): Promise<string> {
  const listed = await deps.tasks.list(projectId, { assignee: instanceId, state: 'todo' })
  if (!listed.ok || listed.value.length === 0) return ''
  const lines = listed.value.map((task) => `  #${task.id} [todo] ${task.title}`).join('\n')
  return `\n你名下还有 ${listed.value.length} 条待领取任务：\n${lines}\n当前任务做完后请立即用 task_claim 领取下一条，不要等唤醒。`
}

export function taskUpdateTool(deps: TaskToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'task_update',
      package: 'task',
      description:
        '汇报任务进展：done（完成）/terminated（终止）。完成或终止前平台会把该任务的全部代码改动结算为一条可回退的产出物。任务没有「受阻」状态：做不下去时说明缺口、改派或直接终止，不要停在中间态。',
      paramsSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id' },
          state: { type: 'string', enum: ['done', 'terminated'], description: '目标状态' },
          note: { type: 'string', description: '汇报说明（做了什么 / 还差什么）' },
        },
        required: ['taskId', 'state'],
      },
      scope: 'platform',
      risk: 'low',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 2_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const taskId = readString(record, 'taskId')
      const state = readString(record, 'state')
      if (taskId === undefined || state === undefined) {
        return { ok: false, text: '缺少 taskId 或 state', errorCode: 'ERR_VALIDATION' }
      }
      if (state !== 'done' && state !== 'terminated') {
        return {
          ok: false,
          text:
            state === 'blocked'
              ? 'task_update 不再接受 blocked：任务没有「受阻」状态，请说明缺口后继续推进，确实做不下去就 terminated，或让发起人改派。'
              : `task_update 只接受 done/terminated（收到 ${state}）`,
          errorCode: 'ERR_VALIDATION',
        }
      }
      const updated = await deps.tasks.setState(context.projectId, taskId, state, {
        actor: context.instanceId,
        ...(readString(record, 'note') === undefined ? {} : { note: readString(record, 'note') as string }),
      })
      if (!updated.ok) return { ok: false, text: updated.error.message, errorCode: updated.error.code }
      const artifacts = updated.value.artifactIds.length
      return {
        ok: true,
        text: `已汇报任务 ${taskId} → ${state}${artifacts === 0 ? '' : `（已结算 ${artifacts} 条产出物）`}${await pendingHint(deps, context.projectId, context.instanceId)}`,
        data: { task: updated.value },
      }
    },
  }
}

export function taskTools(deps: TaskToolDeps): readonly { definition: ToolDefinition; handler: ToolHandler }[] {
  return [taskViewTool(deps), taskListTool(deps), taskAssignTool(deps), taskClaimTool(deps), taskUpdateTool(deps)]
}
