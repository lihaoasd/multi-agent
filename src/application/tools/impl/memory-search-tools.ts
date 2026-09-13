import { registerTool } from '../../../infra/tools/executor.js'
import type { ServiceToolDeps } from './context.js'

/** 记忆与检索工具：`memory_append`（全局写仅 pm）/ `memory_search` / `session_search`。 */
export function registerMemorySearchTools(deps: ServiceToolDeps): void {
  const { memory, search, isVisibleTo } = deps
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
}
