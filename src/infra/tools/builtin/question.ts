import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'

/**
 * 询问工具（tools.md §4、D19-⑦）：`ask_user` 是 Agent 向用户提问的**唯一通道**。
 * 调用即 Agent `waiting`（有 pending 询问的占用者在状态投影里显示 waiting）；
 * 同一 Agent 至多 1 个待答（服务层返回 `ERR_QUESTION_PENDING`）。
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

function readItems(record: Record<string, unknown> | undefined): readonly {
  readonly text: string
  readonly options?: readonly string[]
  readonly required?: boolean
}[] {
  const raw = record?.['items']
  if (!Array.isArray(raw)) return []
  const items: { text: string; options?: readonly string[]; required?: boolean }[] = []
  for (const entry of raw) {
    if (typeof entry === 'object' && entry !== null) {
      const item = entry as Record<string, unknown>
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      if (text.trim().length === 0) continue
      const options = Array.isArray(item['options'])
        ? item['options'].filter((option): option is string => typeof option === 'string')
        : undefined
      items.push({
        text,
        ...(options === undefined ? {} : { options }),
        ...(typeof item['required'] === 'boolean' ? { required: item['required'] } : {}),
      })
    } else if (typeof entry === 'string' && entry.trim().length > 0) {
      items.push({ text: entry })
    }
  }
  return items
}

export function askUserTool(): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'ask_user',
      package: 'interaction',
      description:
        '需要用户决策时向他提问并等待答复（本回合会阻塞在 waiting）。一次最多 6 个问题项；有选项时用户可直接点选。同一时刻只能有一个未答复的提问。',
      paramsSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '提问标题（一句话说清要用户决定什么）' },
          items: {
            type: 'array',
            description: '问题项列表（字符串或 {text, options, required}）',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                required: { type: 'boolean' },
              },
              required: ['text'],
            },
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '只有一个问题项时可用的快捷选项',
          },
        },
        required: ['title'],
      },
      scope: 'platform',
      risk: 'none',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 4_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const title = readString(record, 'title')
      if (title === undefined) return { ok: false, text: '缺少 title', errorCode: 'ERR_VALIDATION' }
      if (context.askUser === undefined) {
        return { ok: false, text: '当前上下文不支持提问（ask_user 未接入）', errorCode: 'ERR_TOOL_REJECTED' }
      }

      const items = readItems(record)
      const shortcut = Array.isArray(record?.['options'])
        ? (record?.['options'] as unknown[]).filter((option): option is string => typeof option === 'string')
        : []
      const effective =
        items.length > 0
          ? items
          : [{ text: title, ...(shortcut.length === 0 ? {} : { options: shortcut }) }]

      const asked = await context.askUser({ title, items: effective })
      if (!asked.ok) return { ok: false, text: asked.error.message, errorCode: asked.error.code }
      const lines = asked.value.answers.map((answer) => {
        const question = effective.find((_item, index) => `i_${index + 1}` === answer.itemId)
        return `- ${question?.text ?? answer.itemId}：${answer.choice ?? answer.text ?? '（空）'}`
      })
      return {
        ok: true,
        text: `用户答复（questionId=${asked.value.questionId}）：\n${lines.join('\n')}`,
        data: { questionId: asked.value.questionId, answers: asked.value.answers },
      }
    },
  }
}
