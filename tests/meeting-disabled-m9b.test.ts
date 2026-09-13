/**
 * 会议功能总开关（M9B，2026-09-13）：`config.meeting.enabled=false` 时关闭整个会议功能。
 *
 * 关闭后的语义：
 *  1) 会议 REST 全部拒绝（`GET /meetings` 返回空列表 + disabled，其余 409 ERR_MEETING_DISABLED）；
 *  2) 角色**看不到** meeting_start/close/talk 三个工具（连"能开会"都不知道）；
 *  3) `/capabilities` 下发 meeting:false 供前端隐藏入口；
 *  4) 已落盘的会议数据保留（重新打开即可继续看到）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { executeTool, listToolDefs } from '../src/infra/tools/executor.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

async function bootWith(enabled: boolean): Promise<void> {
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  config.meeting = { enabled, autoStart: true, autoClose: true }
  svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
}

/** 关掉当前实例再以指定开关重新装配（模拟"改配置后重启"）。 */
async function reboot(enabled: boolean): Promise<void> {
  if (app) await app.close()
  app = null
  await bootWith(enabled)
}

beforeEach(async () => {
  base = await makeTempDir('meeting-off-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
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

async function setup(): Promise<{ pid: string; dev: string; qa: string }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'off', workdir, team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'qa' }] },
  })
  const p = res.json().project
  const team = p.team as Array<{ roleTemplateId: string; instanceId: string }>
  return {
    pid: p.id,
    dev: team.find((t) => t.roleTemplateId === 'dev')!.instanceId,
    qa: team.find((t) => t.roleTemplateId === 'qa')!.instanceId,
  }
}

describe('会议功能关闭（meeting.enabled=false）', () => {
  it('会议 REST 被拒：GET 返回空列表 + disabled，创建/结束等返回 ERR_MEETING_DISABLED', async () => {
    await bootWith(false)
    const { pid, dev, qa } = await setup()

    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    expect(list.statusCode).toBe(200)
    expect(list.json().meetings).toEqual([])
    expect(list.json().disabled).toBe(true)

    const create = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: dev, topic: 'x', members: [qa] },
    })
    expect(create.statusCode).toBe(409)
    expect(create.json().code).toBe('ERR_MEETING_DISABLED')

    const close = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/m_x/close`,
      payload: { actor: 'user' },
    })
    expect(close.statusCode).toBe(409)
    expect(close.json().code).toBe('ERR_MEETING_DISABLED')
  }, 30000)

  it('角色看不到会议工具：meeting_start/close/talk 都不在注册结果里，调用被拒', async () => {
    await bootWith(false)
    const { pid, dev, qa } = await setup()

    // 注册表里根本没有这三个工具（会议关闭时不注册）
    const names = listToolDefs().map((d) => d.name)
    expect(names).not.toContain('meeting_start')
    expect(names).not.toContain('meeting_close')
    expect(names).not.toContain('meeting_talk')

    // 即便直接调用（模拟旧会话残留意图）也被执行器拒绝
    const env = await buildToolEnv({ config, projectService: svc.projectService }, pid, dev, {
      sessionId: `u_${dev}`,
    })
    const res = await executeTool('meeting_start', { topic: 'x', members: [qa] }, env)
    expect(res.ok).toBe(false)
  }, 30000)

  it('能力开关下发 meeting:false；打开时恢复（且已落盘数据保留）', async () => {
    // 先开启时造一场会议（数据落盘）
    await bootWith(true)
    const { pid, dev, qa } = await setup()
    await svc.meetings.create({ projectId: pid, host: dev, topic: '历史会议', desc: 'x', members: [qa] })
    expect((await svc.meetings.list(pid)).length).toBe(1)

    // 关闭后：能力=false、REST 列表为空（前端隐藏入口），但数据仍在盘上
    await reboot(false)
    const caps = await ready().inject({ method: 'GET', url: '/api/capabilities' })
    expect(caps.json().capabilities.meeting).toBe(false)
    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    expect(list.json().meetings).toEqual([])
    // 数据保留：服务层仍能读到（只是 REST 不再对外暴露）
    expect((await svc.meetings.list(pid)).length).toBe(1)

    // 重新打开：能力=true、数据照旧可见（会议记录/主题都还在）
    await reboot(true)
    const caps2 = await ready().inject({ method: 'GET', url: '/api/capabilities' })
    expect(caps2.json().capabilities.meeting).toBe(true)
    const list2 = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
    expect(list2.json().meetings).toHaveLength(1)
    expect(list2.json().meetings[0].meeting.topic).toBe('历史会议')
  }, 60000)
})
