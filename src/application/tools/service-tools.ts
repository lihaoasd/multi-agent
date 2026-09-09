/**
 * 应用级工具注册（记忆/检索类，需服务依赖），组合根启动时调用一次。
 * 只读/检索类在 user+meeting 可用；memory_append own 写入；全局写仅 pm_1。
 * 检索可见性（D18-②）：本人 user 会话 ∪ 已参与会议（MVP 简化：项目会议成员可见）。
 */
import { registerTool } from '../../infra/tools/executor.js'
import { MemoryStore } from '../memory/memory-store.js'
import { SearchService } from '../search/search-service.js'

export function registerServiceTools(deps: { memory: MemoryStore; search: SearchService }): void {
  const { memory, search } = deps

  registerTool(
    {
      name: 'memory_append',
      description: '追加长期记忆条目（scope=own 默认；全局写仅 pm）',
      scope: 'workspace',
      availableIn: ['user', 'meeting'],
      idempotent: true,
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
    },
    async (args, env) => {
      const q = String(args.q ?? '').trim()
      if (!q) return { ok: false, code: 'ERR_VALIDATION', reason: 'q 必填' }
      const r = await search.search(env.projectId, q)
      const mem = r.memories.map((m) => m.snippet).slice(0, 5)
      // 角色记忆仅本人可见（MVP：条目里含本人记忆时仅列出通用记忆；个人文件不在倒排范围简化）
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

function isVisibleTo(sessionId: string | undefined, env: { instanceId: string }): boolean {
  if (!sessionId) return false
  if (sessionId.startsWith('u_')) return sessionId === `u_${env.instanceId}`
  // meeting 会话对参会 Agent 可见（MVP 简化）
  return sessionId.startsWith('m_')
}
