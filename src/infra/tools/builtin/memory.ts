import type { MemoryService, MemoryType } from '../../../ports/memory'
import { MEMORY_TYPES } from '../../../ports/memory'
import type { SearchHit, SearchService } from '../../../ports/search'
import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'
import { visibilityFor, type Viewer } from '../../../domain/rules/visibility'

/**
 * 记忆与检索工具（S5）：`memory_append` / `memory_search` / `session_search`（tools.md §4、memory.md §5）。
 * 可见性一律走 `domain/rules/visibility`：Agent 只能看到"本人会话 ∪ 全局记忆 ∪ 本人角色记忆"。
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

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): readonly string[] {
  const value = record?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function viewerOf(instanceId: string): Viewer {
  return { kind: 'agent', instanceId }
}

function formatHits(hits: readonly SearchHit[]): string {
  return hits
    .map((hit) => {
      const where = hit.scope === 'session' ? `${hit.sessionId}#${hit.seq} (${hit.kind ?? '-'})` : `记忆 ${hit.entryId}`
      return `- [${where}] score=${hit.score} ${hit.tokens.join('/')}\n  ${hit.text}`
    })
    .join('\n')
}

export interface MemoryToolDeps {
  readonly memory: MemoryService
  readonly search: SearchService
}

export function memoryAppendTool(deps: MemoryToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'memory_append',
      package: 'memory',
      description:
        '把一条值得长期记住的信息写入自己的角色记忆（如用户偏好、本人承诺、项目相关事实）。取取代（supersede）由平台处理，你只需追加事实。',
      paramsSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容（一句话，≤2000 字）' },
          type: {
            type: 'string',
            enum: [...MEMORY_TYPES],
            description: '条目类型，默认 fact',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签（≤10）' },
          refs: { type: 'array', items: { type: 'string' }, description: '可选的关联引用（如 artifactId）' },
        },
        required: ['content'],
      },
      scope: 'platform',
      risk: 'low',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 1_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const content = readString(record, 'content')
      if (content === undefined) return { ok: false, text: '缺少 content', errorCode: 'ERR_VALIDATION' }
      const type = (readString(record, 'type') ?? 'fact') as MemoryType
      if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
        return { ok: false, text: `未知记忆类型：${type}`, errorCode: 'ERR_VALIDATION' }
      }

      const written = await deps.memory.appendOwn({
        projectId: context.projectId,
        instanceId: context.instanceId,
        sessionId: context.sessionId,
        seq: context.sourceSeq ?? 0,
        type,
        content,
        tags: readStringArray(record, 'tags'),
        refs: readStringArray(record, 'refs'),
      })
      if (!written.ok) return { ok: false, text: written.error.message, errorCode: written.error.code }
      return {
        ok: true,
        text: `已记住（${written.value.type}，id=${written.value.id}）：${written.value.content}`,
        data: { entryId: written.value.id, type: written.value.type, scope: written.value.scope },
      }
    },
  }
}

export function memorySearchTool(deps: MemoryToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'memory_search',
      package: 'memory',
      description: '在自己的角色记忆与项目全局记忆中检索关键词（中文按二元组匹配），返回命中条目与来源',
      paramsSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          limit: { type: 'number', description: '返回条数上限（默认 5）' },
        },
        required: ['query'],
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
      const query = readString(record, 'query')
      if (query === undefined) return { ok: false, text: '缺少 query', errorCode: 'ERR_VALIDATION' }
      const limit = Math.min(Math.max(readNumber(record, 'limit') ?? 5, 1), 20)

      const found = await deps.search.search({
        projectId: context.projectId,
        query,
        viewer: viewerOf(context.instanceId),
        scope: 'memory',
        limit,
      })
      if (!found.ok) return { ok: false, text: found.error.message, errorCode: found.error.code }
      return {
        ok: true,
        text: found.value.length === 0 ? `记忆中没有找到「${query}」` : `命中 ${found.value.length} 条记忆：\n${formatHits(found.value)}`,
        data: { hits: found.value.length },
      }
    },
  }
}

export function sessionSearchTool(deps: MemoryToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'session_search',
      package: 'session',
      description:
        '在自己的会话历史中检索关键词（中文按二元组匹配），返回命中的会话 id 与 seq，可用于定位历史上下文',
      paramsSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          limit: { type: 'number', description: '返回条数上限（默认 5）' },
        },
        required: ['query'],
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
      const query = readString(record, 'query')
      if (query === undefined) return { ok: false, text: '缺少 query', errorCode: 'ERR_VALIDATION' }
      const limit = Math.min(Math.max(readNumber(record, 'limit') ?? 5, 1), 20)

      const found = await deps.search.search({
        projectId: context.projectId,
        query,
        viewer: viewerOf(context.instanceId),
        scope: 'session',
        limit,
      })
      if (!found.ok) return { ok: false, text: found.error.message, errorCode: found.error.code }
      const mine = visibilityFor(viewerOf(context.instanceId)).sessionIds ?? []
      return {
        ok: true,
        text:
          found.value.length === 0
            ? `你的会话里没有找到「${query}」（可检索会话：${mine.join(', ') || '无'}）`
            : `命中 ${found.value.length} 条会话片段：\n${formatHits(found.value)}`,
        data: { hits: found.value.length, sessions: mine },
      }
    },
  }
}

export function memoryTools(deps: MemoryToolDeps): readonly { definition: ToolDefinition; handler: ToolHandler }[] {
  return [memoryAppendTool(deps), memorySearchTool(deps), sessionSearchTool(deps)]
}
