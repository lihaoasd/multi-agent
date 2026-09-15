import type { ChatMessage, ToolSchema } from '../../ports/model'
import type { StoredEvent } from '../../ports/session'
import type { ProjectMeta } from '../../ports/project'
import { DEFAULT_MAX_PROMPT_CHARS } from '../../shared/loop'
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
  readonly limits: {
    readonly rawWindow: number
    readonly maxCharsPerMsg: number
    readonly maxPromptChars: number
  }
}

function trim(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…（已截断）`
}

function historyToMessages(history: readonly StoredEvent[], limits: BuildContextInput['limits']): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of history) {
    if (event.kind !== 'message') continue
    const role = event.payload['role']
    if (role !== 'user' && role !== 'agent') continue
    const raw =
      typeof event.payload['text'] === 'string'
        ? (event.payload['text'] as string)
        : (() => {
            const content = event.payload['content']
            if (typeof content === 'object' && content !== null) {
              const text = (content as Record<string, unknown>)['text']
              if (typeof text === 'string') return text
            }
            return ''
          })()
    if (raw.trim().length === 0) continue
    messages.push({ role: role === 'user' ? 'user' : 'assistant', content: trim(raw, limits.maxCharsPerMsg) })
  }
  return messages.slice(-limits.rawWindow)
}

export function buildAgentContext(input: BuildContextInput): BuiltContext {
  const { effective, project } = input
  const blocks: ContextBlock[] = []

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
    ].join('\n'),
  })

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

  const historyMessages = historyToMessages(input.history, input.limits)
  blocks.push({
    id: 'session-window',
    origin: 'session-window',
    title: '会话窗口',
    text:
      historyMessages.length === 0
        ? '（本次对话还没有历史消息）'
        : historyMessages
            .map((message) => `${message.role === 'user' ? '用户' : effective.displayName}：${message.content}`)
            .join('\n'),
  })

  const systemText = blocks.map((block) => `## ${block.title}\n${block.text}`).join('\n\n')
  return {
    blocks,
    messages: [{ role: 'system', content: systemText }, ...historyMessages],
    text: systemText,
  }
}
