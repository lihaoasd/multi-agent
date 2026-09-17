import type { ChatMessage, ToolSchema } from '../../ports/model'
import type { ArtifactRecord, FileOwnerRecord } from '../../ports/artifact'
import type { MemoryEntry } from '../../ports/memory'
import type { SearchHit } from '../../ports/search'
import type { TaskRecord } from '../../ports/task'
import type { StoredEvent } from '../../ports/session'
import type { ProjectMeta } from '../../ports/project'
import { DEFAULT_MAX_PROMPT_CHARS, SUMMARY_PROMPT_CHARS } from '../../shared/loop'
import { digestToText, type SummaryDigest } from '../memory/summary-engine'
import type { EffectiveAgentConfig } from '../team/effective-config'

/**
 * 上下文组装（agent-runtime.md §4）：分层拼接 + 可预览。
 * 与"系统提示词预览"接口**同源**（同一函数），保证预览与运行期一致（Builder 模式）。
 */

export type ContextBlockOrigin =
  | 'role-config'
  | 'platform-role'
  | 'global-memory'
  | 'role-memory'
  | 'session-window'
  | 'retrieval'
  | 'task-context'
  | 'artifact-index'
  | 'tools'

export interface ContextBlock {
  readonly id: string
  readonly origin: ContextBlockOrigin
  readonly title: string
  readonly text: string
}

export interface BuiltContext {
  readonly blocks: readonly ContextBlock[]
  /** 直接发给模型的 messages（system 段 = 所有块拼接） */
  readonly messages: readonly ChatMessage[]
  /** 预览全文（= system 段） */
  readonly text: string
}

export interface BuildContextInput {
  readonly project: Pick<ProjectMeta, 'id' | 'name' | 'workdir'>
  readonly effective: EffectiveAgentConfig
  /** 会话历史事件（按时间正序） */
  readonly history: readonly StoredEvent[]
  readonly toolSchemas: readonly ToolSchema[]
  /** 激活的 L3 记忆条目（global + 本人角色）；缺省表示不注入（预览/测试可省略） */
  readonly memories?: readonly MemoryEntry[]
  /** 检索命中片段（按需注入，最多 `contextLimits.search.maxSnippets` 条） */
  readonly snippets?: readonly SearchHit[]
  /** 当前激活任务（只注入 `in_progress`；todo 不入上下文，规则 15） */
  readonly task?: TaskRecord
  /**
   * 我委派出去的任务（S36/D39）：`updatedAt` 倒序，注入为 `[委派任务]` 块，
   * 让委派人"接收到回报后继续执行"不依赖单条聊天消息。
   */
  readonly delegatedTasks?: readonly TaskRecord[]
  /** 产出物署名（`file-owners`）：我的（可改）/ 他人的（只读）（workspaces-artifacts §2.2） */
  readonly ownership?: { readonly mine: readonly FileOwnerRecord[]; readonly others: readonly FileOwnerRecord[] }
  /** 项目产出物索引（名称/版本/文件数，内容按需读） */
  readonly artifacts?: readonly ArtifactRecord[]
  readonly limits: {
    readonly rawWindow: number
    readonly maxCharsPerMsg: number
    readonly maxPromptChars: number
    readonly maxSnippets?: number
  }
}

function trim(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…（已截断）`
}

function messageText(event: StoredEvent): string {
  const direct = event.payload['text']
  if (typeof direct === 'string') return direct
  const content = event.payload['content']
  if (typeof content === 'object' && content !== null) {
    const text = (content as Record<string, unknown>)['text']
    if (typeof text === 'string') return text
  }
  return ''
}

/** 最近一条滚动摘要（L2）：既决定"摘要替代哪段原文"，也用于拼 `【历史摘要】` 段 */
function latestSummary(history: readonly StoredEvent[]): { readonly toSeq: number; readonly text: string } | null {
  let found: { readonly toSeq: number; readonly text: string } | null = null
  for (const event of history) {
    if (event.kind !== 'summary') continue
    const toSeq = event.payload['toSeq']
    if (typeof toSeq !== 'number' || !Number.isFinite(toSeq)) continue
    const digest = event.payload['digest']
    const text =
      typeof digest === 'object' && digest !== null
        ? digestToText(digest as SummaryDigest)
        : typeof event.payload['text'] === 'string'
          ? (event.payload['text'] as string)
          : ''
    if (text.trim().length > 0) found = { toSeq, text }
  }
  return found
}

function historyToMessages(
  history: readonly StoredEvent[],
  limits: BuildContextInput['limits'],
  coveredToSeq: number,
): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of history) {
    if (event.kind !== 'message' || event.seq <= coveredToSeq) continue
    const role = event.payload['role']
    if (role !== 'user' && role !== 'agent') continue
    const raw = messageText(event)
    if (raw.trim().length === 0) continue
    messages.push({ role: role === 'user' ? 'user' : 'assistant', content: trim(raw, limits.maxCharsPerMsg) })
  }
  return messages.slice(-limits.rawWindow)
}

function memoryLines(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '（暂无）'
  return entries
    .map((entry) => `- [${entry.type}] ${entry.content}（source=${entry.source.sessionId}#${entry.source.seq}）`)
    .join('\n')
}

/** `[委派任务]` 块最多列出的条数（超出只给一行提示，防止提示词随项目变长无界膨胀） */
export const MAX_DELEGATED_TASKS_IN_PROMPT = 8

/** 委派任务摘要行：`- t_1 → dev_1：《标题》：done（备注）` */
export function delegatedTaskLine(task: TaskRecord): string {
  const note = task.note?.trim() ?? ''
  return `- ${task.id} → ${task.assignee}：《${task.title}》：${task.state}${note === '' ? '' : `（${note}）`}`
}

export function buildAgentContext(input: BuildContextInput): BuiltContext {
  const { effective, project } = input
  const blocks: ContextBlock[] = []
  const summary = latestSummary(input.history)

  blocks.push({
    id: 'role-config',
    origin: 'role-config',
    title: '角色配置（提示词）',
    text: trim(effective.systemPrompt, input.limits.maxPromptChars || DEFAULT_MAX_PROMPT_CHARS),
  })

  blocks.push({
    id: 'platform-role',
    origin: 'platform-role',
    title: '平台角色定位',
    text: [
      `你是「${effective.displayName}」（角色模板 ${effective.roleTemplateId}），本项目的成员之一。`,
      `项目：${project.name}（id=${project.id}）。`,
      `用户是老板：需要决策时用 ask_user 提问并等待答复；不要假设用户的意图。`,
      `你的产出物只能落在项目工作目录内（当前工作目录：${project.workdir}）。`,
      // S21/D27：中断收尾由 Agent 自己判断并发起询问（平台既不判定"未完成回合"，也不给固定选项）
      `开工前若你怀疑上一个回合没有正常收尾（例如服务刚重启、你要接着做上次没做完的事），先用 session_recent 核对本会话最近事件：若最后一个【回合开始】之后没有对应的【回合结束】，或你的最后一条回复明显不完整，就先用文字说明现状，并用 ask_user 问我怎么处理——不要擅自续跑，也不要假装没发生。`,
    ].join('\n'),
  })

  if (input.memories !== undefined) {
    blocks.push({
      id: 'global-memory',
      origin: 'global-memory',
      title: '全局记忆',
      text: memoryLines(input.memories.filter((entry) => entry.scope === 'global')),
    })
    blocks.push({
      id: 'role-memory',
      origin: 'role-memory',
      title: '个人记忆',
      text: memoryLines(input.memories.filter((entry) => entry.scope === 'agent')),
    })
  }

  const historyMessages = historyToMessages(input.history, input.limits, summary?.toSeq ?? 0)
  blocks.push({
    id: 'session-window',
    origin: 'session-window',
    title: '会话窗口',
    text: [
      ...(summary === null ? [] : [`【历史摘要（至 seq ${summary.toSeq}）】\n${trim(summary.text, SUMMARY_PROMPT_CHARS)}`]),
      historyMessages.length === 0
        ? '（没有需要逐条回顾的近期消息）'
        : historyMessages
            .map((message) => `${message.role === 'user' ? '用户' : effective.displayName}：${message.content}`)
            .join('\n'),
    ].join('\n\n'),
  })

  const snippets = (input.snippets ?? []).slice(0, input.limits.maxSnippets ?? 3)
  if (snippets.length > 0) {
    blocks.push({
      id: 'retrieval',
      origin: 'retrieval',
      title: '检索片段',
      text: snippets
        .map((hit) => {
          const where = hit.scope === 'session' ? `会话 ${hit.sessionId}#${hit.seq}` : `记忆 ${hit.entryId}`
          return `- [${where}] ${hit.text}`
        })
        .join('\n'),
    })
  }

  if (input.task !== undefined) {
    blocks.push({
      id: 'task-context',
      origin: 'task-context',
      title: '当前任务',
      text: [
        `任务 ${input.task.id}：${input.task.title}（${input.task.state}｜发起：${input.task.creator}）`,
        ...(input.task.desc.length === 0 ? [] : [`说明：${input.task.desc}`]),
        '你的代码改动会计入这条任务；完成后用 task_update 汇报 done（平台会结算为可回退的产出物）。',
      ].join('\n'),
    })
  }

  // 我派出去的活干到哪了（S36/D39）：委派人靠这块"接收到回报并继续"，而不是靠翻聊天记录
  const delegated = input.delegatedTasks ?? []
  if (delegated.length > 0) {
    const shown = delegated.slice(0, MAX_DELEGATED_TASKS_IN_PROMPT)
    blocks.push({
      id: 'delegated-tasks',
      origin: 'task-context',
      title: '我委派出去的任务',
      text: [
        '以下是**你派给其他角色**的任务（最近更新在前）：',
        ...shown.map((task) => delegatedTaskLine(task)),
        ...(delegated.length > shown.length
          ? [`（另有 ${delegated.length - shown.length} 条，需要时用 task_list 查看全部）`]
          : []),
        '回报到达后请据此继续你自己的计划：已完成的结果直接用起来推进下一步；受阻或终止的，决定调整方案、重新派单还是自己接手。',
      ].join('\n'),
    })
  }

  if (input.ownership !== undefined || (input.artifacts?.length ?? 0) > 0) {
    const lines: string[] = []
    if (input.ownership !== undefined) {
      lines.push(
        input.ownership.mine.length === 0
          ? '我的产出物（可改）：暂无'
          : `我的产出物（可改）：\n${input.ownership.mine.map((item) => `- ${item.relPath}`).join('\n')}`,
      )
      lines.push(
        input.ownership.others.length === 0
          ? '他人产出物（只读）：暂无'
          : `他人产出物（只读）：\n${input.ownership.others
              .map((item) => `- ${item.relPath}（署名：${item.ownerName}）`)
              .join('\n')}`,
      )
    }
    if ((input.artifacts?.length ?? 0) > 0) {
      lines.push(
        `最近产出物：\n${(input.artifacts ?? [])
          .map(
            (item) =>
              `- ${item.id} v${item.version} [${item.type}/${item.state}] ${item.title}（${item.files.length} 文件，+${item.diffSummary.add}/-${item.diffSummary.del}）`,
          )
          .join('\n')}`,
      )
    }
    blocks.push({
      id: 'artifact-index',
      origin: 'artifact-index',
      title: '产出物索引与署名',
      text: lines.join('\n'),
    })
  }

  if (input.toolSchemas.length > 0) {
    blocks.push({
      id: 'tools',
      origin: 'tools',
      title: '可用工具',
      text: [
        '你可以通过工具调用（function calling）使用下列工具；需要外部信息或改文件时必须调用工具，不要凭空编造。',
        ...input.toolSchemas.map((tool) => `- ${tool.name}：${tool.description}`),
      ].join('\n'),
    })
  }

  const systemText = blocks.map((block) => `## ${block.title}\n${block.text}`).join('\n\n')
  return {
    blocks,
    messages: [{ role: 'system', content: systemText }, ...historyMessages],
    text: systemText,
  }
}
