import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'
import type { MemoryEntry } from '../../../src/ports/memory'
import type { SearchHit } from '../../../src/ports/search'
import type { ToolCallContext, ToolOutcome } from '../../../src/ports/tools'

interface MemoriesBody {
  entries: MemoryEntry[]
  count: number
}

interface SearchBody {
  query: string
  count: number
  sessionHits: SearchHit[]
  memoryHits: SearchHit[]
}

/** 规则 6 / 7 / 13：记忆列表、中文检索、原始时间线 */
describe('API · 记忆与检索（规则 6 / 7 / 13）', () => {
  let context: TestContext
  let projectId: string

  beforeAll(async () => {
    context = await createTestServer()
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '记忆与检索演示', workdir: mkdtempSync(join(tmpdir(), 'ah-memory-api-')) },
    })
    projectId = created.json<{ id: string }>().id

    // 直接写两条会话日志（不占用真实回合，规则 13 的时间线视图）
    await context.deps.sessions.append(projectId, 'u_dev_1', [
      { kind: 'message', turn: 1, payload: { role: 'user', text: '实现登录模块', content: { text: '实现登录模块' } } },
      { kind: 'turn_start', turn: 1, payload: { loopStep: 'direct' } },
      { kind: 'message', turn: 1, payload: { role: 'agent', text: '已完成登录模块骨架', content: { text: '已完成登录模块骨架' } } },
    ])
    await context.deps.sessions.append(projectId, 'u_qa_1', [
      { kind: 'message', turn: 1, payload: { role: 'user', text: '回归测试支付流程', content: { text: '回归测试支付流程' } } },
    ])

    // L3：角色记忆 + 全局记忆
    await context.deps.memory.appendOwn({
      projectId,
      instanceId: 'dev_1',
      sessionId: 'u_dev_1',
      seq: 3,
      type: 'preference',
      content: '用户偏好中文注释',
      tags: ['偏好'],
    })
    await context.deps.memory.appendOwn({
      projectId,
      instanceId: 'qa_1',
      sessionId: 'u_qa_1',
      seq: 1,
      type: 'fact',
      content: '测试环境使用独立数据库',
    })
    await context.deps.memory.recordGlobal({
      projectId,
      sessionId: 'u_dev_1',
      seq: 1,
      type: 'decision',
      content: '登录方案采用 JWT',
    })
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('记忆列表只读可用：按 scope/instanceId/type 过滤（规则 6）', async () => {
    const all = await inject({ method: 'GET', url: `/api/projects/${projectId}/memories` })
    expect(all.statusCode).toBe(200)
    expect(all.json<MemoriesBody>().count).toBe(3)

    const globalOnly = await inject({ method: 'GET', url: `/api/projects/${projectId}/memories?scope=global` })
    expect(globalOnly.json<MemoriesBody>().entries.map((entry) => entry.content)).toEqual(['登录方案采用 JWT'])

    const devOnly = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?scope=agent&instanceId=dev_1&type=preference`,
    })
    const devEntries = devOnly.json<MemoriesBody>().entries
    expect(devEntries).toHaveLength(1)
    expect(devEntries[0]).toMatchObject({ instanceId: 'dev_1', type: 'preference', state: 'active' })
    expect(devEntries[0]?.source).toEqual({ sessionId: 'u_dev_1', seq: 3 })
  })

  it('记忆列表参数非法 → 400 ERR_VALIDATION', async () => {
    const bad = await inject({ method: 'GET', url: `/api/projects/${projectId}/memories?type=unknown` })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<{ code: string }>().code).toBe('ERR_VALIDATION')
  })

  it('中文检索：2-gram 命中并给出可跳转的 (sessionId, seq)（规则 7）', async () => {
    const found = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/search?q=${encodeURIComponent('登录模块')}`,
    })
    expect(found.statusCode).toBe(200)
    const body = found.json<SearchBody>()
    expect(body.count).toBeGreaterThan(0)
    expect(body.sessionHits.length).toBeGreaterThan(0)
    const top = body.sessionHits[0]
    expect(top).toMatchObject({ sessionId: 'u_dev_1', kind: 'message' })
    // 命中都带可跳转的 seq（1=用户消息、3=Agent 回复）
    expect(body.sessionHits.map((hit) => hit.seq)).toEqual(expect.arrayContaining([1, 3]))
    expect(top?.tokens).toEqual(expect.arrayContaining(['登录', '录模', '模块']))
    // 结果按会话/记忆分组：记忆侧只可能命中"登录方案采用 JWT"这条全局决策
    expect(body.memoryHits.map((hit) => hit.text)).toEqual([expect.stringContaining('登录方案采用 JWT')])
    expect(body.memoryHits.every((hit) => hit.scope === 'memory' && hit.sessionId === null)).toBe(true)
  })

  it('检索可按 scope/type 过滤到记忆，并区分会话与记忆分组（规则 7）', async () => {
    const memoryOnly = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/search?q=${encodeURIComponent('中文注释')}&type=memory`,
    })
    const body = memoryOnly.json<SearchBody>()
    expect(body.sessionHits).toEqual([])
    expect(body.memoryHits.map((hit) => hit.text)).toEqual([expect.stringContaining('中文注释')])

    const sessionOnly = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/search?q=${encodeURIComponent('支付流程')}&scope=session&sessionId=u_qa_1`,
    })
    expect(sessionOnly.json<SearchBody>().sessionHits[0]).toMatchObject({ sessionId: 'u_qa_1', seq: 1 })

    const badScope = await inject({ method: 'GET', url: `/api/projects/${projectId}/search?q=a&scope=unknown` })
    expect(badScope.statusCode).toBe(400)
  })

  it('索引统计与重建：派生投影可一键重建（规则 7）', async () => {
    const stats = await inject({ method: 'GET', url: `/api/projects/${projectId}/search/stats` })
    expect(stats.statusCode).toBe(200)
    expect(stats.json<{ documents: number }>().documents).toBeGreaterThan(0)

    const rebuilt = await inject({ method: 'POST', url: `/api/projects/${projectId}/search/reindex` })
    expect(rebuilt.statusCode).toBe(200)
    const body = rebuilt.json<{ documents: number; tokens: number; builtAt: string | null }>()
    expect(body.documents).toBeGreaterThan(0)
    expect(body.tokens).toBeGreaterThan(0)
    expect(body.builtAt).not.toBeNull()

    // 重建后检索仍正确
    const after = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/search?q=${encodeURIComponent('登录模块')}`,
    })
    expect(after.json<SearchBody>().count).toBeGreaterThan(0)
  })

  it('原始时间线：按 kind 过滤完整可拉取，limit 为尾窗（规则 13）', async () => {
    const all = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log` })
    expect(all.statusCode).toBe(200)
    const events = all.json<Array<{ seq: number; kind: string }>>()
    expect(events.map((event) => event.kind)).toEqual(['message', 'turn_start', 'message'])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])

    const messagesOnly = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/u_dev_1/log?kind=message`,
    })
    expect(messagesOnly.json<Array<{ kind: string }>>().every((event) => event.kind === 'message')).toBe(true)

    const tail = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log?limit=1` })
    expect(tail.json<Array<{ seq: number }>>()).toEqual([expect.objectContaining({ seq: 3 })])

    const fromSeq = await inject({ method: 'GET', url: `/api/projects/${projectId}/sessions/u_dev_1/log?fromSeq=3` })
    expect(fromSeq.json<Array<{ seq: number }>>().map((event) => event.seq)).toEqual([3])
  })

  it('工具：memory_append / memory_search / session_search 走同一可见性（规则 6 / 7）', async () => {
    const call = async (name: string, args: unknown, instanceId: string): Promise<ToolOutcome> => {
      const entry = context.deps.toolRegistry.get(name)
      expect(entry).toBeDefined()
      if (entry === undefined) throw new Error(`工具未注册：${name}`)
      const toolContext: ToolCallContext = {
        projectId,
        instanceId,
        sessionId: `u_${instanceId}`,
        sessionType: 'user',
        turn: 1,
        sourceSeq: 9,
        roots: { workdir: process.cwd(), runtime: process.cwd(), readonly: [] },
        requestApproval: async () => ({ ok: true, value: { decision: 'approved' as const, approvalId: null } }),
        signal: new AbortController().signal,
      }
      return entry.handler(args, toolContext)
    }

    const appended = await call('memory_append', { content: '开发记得补单元测试', type: 'commitment' }, 'dev_1')
    expect(appended.ok).toBe(true)
    expect(appended.data?.['scope']).toBe('agent')

    const mine = await call('memory_search', { query: '单元测试' }, 'dev_1')
    expect(mine.ok && mine.text).toContain('开发记得补单元测试')

    // 可见性：qa_1 看不到 dev_1 的角色记忆（同关键词只命中自己那条），但能看到项目全局记忆
    const theirs = await call('memory_search', { query: '单元测试' }, 'qa_1')
    expect(theirs.ok && theirs.text).not.toContain('开发记得补单元测试')
    expect(theirs.ok && theirs.text).toContain('测试环境使用独立数据库')

    const globalForQa = await call('memory_search', { query: 'JWT' }, 'qa_1')
    expect(globalForQa.ok && globalForQa.text).toContain('登录方案采用 JWT')

    const ownSession = await call('session_search', { query: '登录模块' }, 'dev_1')
    expect(ownSession.ok && ownSession.text).toContain('u_dev_1')
    const crossSession = await call('session_search', { query: '支付流程' }, 'dev_1')
    expect(crossSession.ok && crossSession.text).toContain('没有找到')
  })

  it('系统提示词预览出现记忆块（与运行期同源；规则 6）', async () => {
    const preview = await inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agents/dev_1/system-prompt`,
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json<{ blocks: Array<{ id: string; text: string }> }>()
    const ids = body.blocks.map((block) => block.id)
    expect(ids).toEqual(
      expect.arrayContaining(['role-config', 'platform-role', 'global-memory', 'role-memory', 'session-window', 'tools']),
    )
    // 运行期同源：全局记忆与个人记忆分别进块
    expect(body.blocks.find((block) => block.id === 'global-memory')?.text).toContain('登录方案采用 JWT')
    expect(body.blocks.find((block) => block.id === 'role-memory')?.text).toContain('用户偏好中文注释')
  })
})
