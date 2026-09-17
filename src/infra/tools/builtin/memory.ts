import type { MemoryService, MemoryType } from '../../../ports/memory'
import { MEMORY_TYPES } from '../../../ports/memory'
import type { SearchHit, SearchService } from '../../../ports/search'
import type { SessionLogStore, StoredEvent } from '../../../ports/session'
import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'
import { visibilityFor, type Viewer } from '../../../domain/rules/visibility'

/**
 * 记忆与检索工具（S5）：`memory_append` / `memory_search` / `session_search` / `session_recent`（tools.md §4、memory.md §5）。
 * 可见性一律走 `domain/rules/visibility`：Agent 只能看到"本人会话 ∪ 全局记忆 ∪ 本人角色记忆"。
 *
 * ⚠️ S21/D27（2026-09-16）：新增 **`session_recent`** —— 平台不再判定"未完成回合"，
 * 由 Agent 自己查看本会话最近事件（含回合边界 `turn_start`/`turn_end`）判断上一回合是否收尾，
 * 需要决策时用 `ask_user` 询问用户。该工具**只给事实、不给结论**。
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
  /** 会话日志端口（**尾窗**语义）：供 `session_recent` 读取本会话最近事件；只读，且只用 `context.sessionId` */
  readonly sessionLog: SessionLogStore
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

function summarizeEvent(event: StoredEvent): string {
  const payload = event.payload
  if (event.kind === 'turn_start') {
    const steps = payload['steps']
    const loopStep = typeof payload['loopStep'] === 'string' ? payload['loopStep'] : null
    const parts = [loopStep === null ? null : `loop=${loopStep}`, Array.isArray(steps) ? `plan ${steps.length} 步` : null]
    return `【回合开始】${parts.filter((part) => part !== null).join(' · ')}`
  }
  if (event.kind === 'turn_end') {
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null
    const status = typeof payload['status'] === 'string' ? payload['status'] : null
    return `【回合结束】${[status, reason].filter((part) => part !== null).join(' · ')}`
  }
  if (event.kind === 'message') {
    const role = typeof payload['role'] === 'string' ? payload['role'] : '?'
    return `${role === 'user' ? '用户' : '我'}：${clip(textOf(payload), 160)}`
  }
  if (event.kind === 'plan') {
    const steps = payload['steps']
    const status = typeof payload['status'] === 'string' ? payload['status'] : '?'
    return `计划（${status}）：${Array.isArray(steps) ? `${steps.length} 步` : '—'}`
  }
  if (event.kind === 'tool_call') {
    // 生产者（application/agent-loop/strategies.ts）写的是 { tool, callId, input }；S24 修复此处字段错配
    const name = typeof payload['tool'] === 'string' ? payload['tool'] : typeof payload['name'] === 'string' ? payload['name'] : '?'
    const input = payload['input'] ?? payload['args']
    return `工具调用 ${name} ${clip(typeof input === 'string' ? input : JSON.stringify(input ?? {}), 200)}`
  }
  if (event.kind === 'tool_result') {
    const ok = payload['ok'] === false ? '失败' : '成功'
    const name = typeof payload['tool'] === 'string' ? payload['tool'] : null
    return `工具结果（${ok}${name === null ? '' : ` ${name}`}）：${clip(textOf(payload), 200)}`
  }
  if (event.kind === 'error') {
    return `错误：${clip(textOf(payload), 200)}`
  }
  if (event.kind === 'state') {
    return `状态：${clip(JSON.stringify(payload), 160)}`
  }
  return `${event.kind}：${clip(textOf(payload), 160)}`
}

function textOf(payload: Record<string, unknown>): string {
  if (typeof payload['text'] === 'string') return payload['text']
  if (typeof payload['message'] === 'string') return payload['message']
  const content = payload['content']
  if (typeof content === 'object' && content !== null) {
    const text = (content as Record<string, unknown>)['text']
    if (typeof text === 'string') return text
  }
  if (typeof payload['summary'] === 'string') return payload['summary']
  return ''
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

const DEFAULT_RECENT_LIMIT = 30
const MAX_RECENT_LIMIT = 100

/**
 * `session_recent`（S21/D27）：查看**本会话**最近事件（含回合边界 `turn_start`/`turn_end`）。
 * 用途：Agent 自己判断"上一个回合是否正常收尾、我最后一条回复是否完整"，再决定是否用 `ask_user` 询问用户。
 * **只给事实不给结论**——平台不做"未完成回合"判定；也不接受 sessionId 参数（只能读自己的会话）。
 */
export function sessionRecentTool(deps: MemoryToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'session_recent',
      package: 'session',
      description:
        '查看本会话最近的事件流水（含【回合开始】/【回合结束】边界、消息、工具调用、计划、错误）。' +
        '当你怀疑上一个回合没有正常收尾（例如服务/进程刚重启过、你要接着做上次没做完的事）时，先用它核对：' +
        '若最后一个【回合开始】之后没有对应的【回合结束】，说明那一回合被打断了；' +
        '若你最后一条回复明显不完整，说明输出被截断。需要决策时用 ask_user 询问用户，不要擅自续跑或改写结论。',
      paramsSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `返回最近多少条事件（默认 ${DEFAULT_RECENT_LIMIT}，上限 ${MAX_RECENT_LIMIT}）` },
        },
        required: [],
      },
      scope: 'platform',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 6_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const requested = readNumber(record, 'limit') ?? DEFAULT_RECENT_LIMIT
      const limit = Math.min(Math.max(Math.floor(requested), 1), MAX_RECENT_LIMIT)

      const found = await deps.sessionLog.readWindow(context.projectId, context.sessionId, { limit })
      if (!found.ok) return { ok: false, text: found.error.message, errorCode: found.error.code }

      if (found.value.length === 0) {
        return { ok: true, text: `本会话（${context.sessionId}）还没有事件。`, data: { events: 0 } }
      }
      const lines = found.value.map(
        (event) => `#${event.seq} [turn ${event.turn}] ${event.ts} ${summarizeEvent(event)}`,
      )
      return {
        ok: true,
        text: [
          `本会话（${context.sessionId}）最近 ${found.value.length} 条事件（旧 → 新）：`,
          ...lines,
          '提示：【回合开始】没有对应【回合结束】= 那一回合被打断；判断后如需决策，用 ask_user 询问用户。',
        ].join('\n'),
        data: {
          events: found.value.length,
          firstSeq: found.value[0]?.seq ?? null,
          lastSeq: found.value[found.value.length - 1]?.seq ?? null,
        },
      }
    },
  }
}

export function memoryTools(deps: MemoryToolDeps): readonly { definition: ToolDefinition; handler: ToolHandler }[] {
  return [memoryAppendTool(deps), memorySearchTool(deps), sessionSearchTool(deps), sessionRecentTool(deps)]
}
