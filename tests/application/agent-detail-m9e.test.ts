/**
 * 角色详情（只读）：GET /api/projects/:pid/agents/:iid（2026-09-13）。
 * 覆盖：配置字段（提示词/loop/模型/模板）、工具口径与运行期一致、白名单里的过时工具、
 * 404、停用态，以及列表接口不受影响。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { listToolDefs } from '../../src/infra/tools/executor.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

/** 平台交互工具（user 会话始终可用）——测试侧独立列一遍，避免与被测实现同源。 */
const PLATFORM_USER_TOOLS = new Set([
  'ask_user',
  'task_assign',
  'task_claim',
  'task_update',
  'artifact_submit',
])

let base: string
let workdir: string
let app: FastifyInstance | null = null

beforeEach(async () => {
  base = await makeTempDir('agent-detail-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  app = await buildApp(composeServices(config, join(base, 'roles')))
})
afterEach(async () => {
  await app?.close()
  app = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

function ready(): FastifyInstance {
  if (!app) throw new Error('app not ready')
  return app
}

async function setup(roles: string[]): Promise<{
  pid: string
  team: TeamMemberConfig[]
  id: (r: string) => string
}> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'detail', workdir, team: roles.map((r) => ({ roleTemplateId: r })) },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    team,
    id: (r: string) => team.find((t) => t.roleTemplateId === r)!.instanceId,
  }
}

interface AgentDetail {
  instanceId: string
  displayName: string
  roleTemplateId: string
  enabled: boolean
  state: string
  createdAt: string
  model: string
  loop: { strategy: string; params: Record<string, unknown> }
  prompt: string
  promptSource: 'instance' | 'none'
  tools: {
    effective: Array<{ name: string; source: string; availableIn: string[] }>
    unavailable: Array<{ name: string; availableIn?: string[] }>
  }
  template: { roleId: string; name: string; category: string; source: string } | null
}

async function detail(
  pid: string,
  iid: string,
): Promise<{ status: number; code?: string; agent: AgentDetail }> {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents/${iid}` })
  const body = res.json()
  return { status: res.statusCode, code: body.code, agent: body.agent }
}

/** 运行期口径的期望工具名（注册表 ∩ 会话类型 ∩ 白名单/平台工具）。 */
function expectedUserTools(member: TeamMemberConfig): string[] {
  const allowed = new Set(member.tools ?? [])
  return listToolDefs()
    .filter(
      (d) =>
        d.availableIn.includes('user') && (allowed.has(d.name) || PLATFORM_USER_TOOLS.has(d.name)),
    )
    .map((d) => d.name)
}

describe('角色详情 GET /api/projects/:pid/agents/:iid', () => {
  it('返回实例配置：提示词快照 / loop / 模型 / 模板来源 / 创建时间', async () => {
    const { pid, id } = await setup(['dev'])
    const { status, agent } = await detail(pid, id('dev'))
    expect(status).toBe(200)
    expect(agent.instanceId).toBe('dev_1')
    expect(agent.displayName).toBe('高级开发')
    expect(agent.promptSource).toBe('instance')
    expect(agent.prompt).toContain('你是高级开发工程师') // 创建实例时的模板快照
    expect(agent.loop.strategy).toBe('plan-execute')
    expect(agent.model).toBe('mock') // 测试环境 models.default=mock
    expect(agent.template).toMatchObject({ roleId: 'dev', name: '高级开发', source: 'builtin' })
    expect(agent.createdAt).toBeTruthy()
    expect(agent.enabled).toBe(true)
    expect(agent.state).toBe('idle')
  })

  it('工具清单 = 运行期口径（白名单 ∩ 会话类型 ∩ 注册表 + 平台工具），并标注来源', async () => {
    const { pid, team, id } = await setup(['dev', 'pm'])
    const devMember = team.find((m) => m.roleTemplateId === 'dev')!
    const dev = (await detail(pid, id('dev'))).agent

    // 与运行期逐名一致（顺序也一致：沿用注册表顺序）
    expect(dev.tools.effective.map((t) => t.name)).toEqual(expectedUserTools(devMember))
    const devTools = new Map(dev.tools.effective.map((t) => [t.name, t.source]))
    expect(devTools.get('workdir_edit')).toBe('whitelist')
    expect(devTools.get('cmd_run')).toBe('whitelist')
    expect(devTools.get('ask_user')).toBe('platform')
    // 会议专用工具在 user 会话不生效，但白名单里配了 → 进"用不上"清单
    expect(devTools.has('meeting_advance')).toBe(false)
    // dev 白名单里的 fs_search / artifact_rollback / meeting_advance / meeting_ask_user
    // 都**没有注册**（工具尚未实现）：详情把它如实暴露出来，而不是假装有
    const missNames = dev.tools.unavailable.map((t) => t.name)
    expect(missNames).toEqual(
      expect.arrayContaining([
        'fs_search',
        'artifact_rollback',
        'meeting_advance',
        'meeting_ask_user',
      ]),
    )
    expect(dev.tools.unavailable.every((t) => t.availableIn === undefined)).toBe(true)

    // pm 白名单没有写/执行能力，但平台交互工具照常可用
    const pm = (await detail(pid, id('pm'))).agent
    const pmTools = new Set(pm.tools.effective.map((t) => t.name))
    expect(pmTools.has('workdir_edit')).toBe(false)
    expect(pmTools.has('cmd_run')).toBe(false)
    expect(pmTools.has('artifact_submit')).toBe(true)
  })

  it('白名单里留着已下线的工具 → 进"用不上"清单（无 availableIn = 注册表里已没有）', async () => {
    const { pid, id } = await setup(['pm'])
    const iid = id('pm')
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/team/${iid}`,
      payload: { tools: ['fs_read_file', 'ws_read'] }, // ws_read 已于 2026-09-12 下线（不再注册）
    })
    const agent = (await detail(pid, iid)).agent
    expect(agent.tools.effective.map((t) => t.name)).toContain('fs_read_file')
    expect(agent.tools.unavailable).toEqual([{ name: 'ws_read' }])
  })

  it('提示词为 null（未设置）时给出空提示词 + promptSource=none', async () => {
    const { pid, id } = await setup(['dev'])
    const iid = id('dev')
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/team/${iid}`,
      payload: { prompt: null },
    })
    const agent = (await detail(pid, iid)).agent
    expect(agent.prompt).toBe('')
    expect(agent.promptSource).toBe('none')
  })

  it('不存在的实例 → 404；停用后 state=disabled，且列表接口不受影响', async () => {
    const { pid, id } = await setup(['pm', 'dev'])
    const miss = await detail(pid, 'ghost_1')
    expect(miss.status).toBe(404)
    expect(miss.code).toBe('ERR_NOT_FOUND')

    const iid = id('pm')
    await ready().inject({ method: 'DELETE', url: `/api/projects/${pid}/team/${iid}` })
    const agent = (await detail(pid, iid)).agent
    expect(agent.enabled).toBe(false)
    expect(agent.state).toBe('disabled')

    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    expect(list.statusCode).toBe(200)
    expect(list.json().agents).toHaveLength(2)
  })
})
