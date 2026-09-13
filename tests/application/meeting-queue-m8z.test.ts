/**
 * 会议并发与两态呈现（M8Z，2026-09-12）。
 *
 * 用户定稿：
 *  1) **同一时刻只允许一个会议进行**，其余排队等待；
 *  2) 角色在已有会议进行时想发起会议 → **等待**（发起成功但排队，不要反复重试）；
 *  3) 会议对用户**只有「进行中」和「已结束」两态**（内部 queued/proposed/open/blocked 都是"进行中"的子态，
 *     排队时额外标注"等待中"）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { executeTool } from '../../src/infra/tools/executor.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

interface MeetingUi {
  id: string
  state: string
  displayState?: string
  waiting?: boolean
  meeting: { topic: string; host: string; members: string[] }
}

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('meeting-queue-')
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

/**
 * 建项目并装配服务。
 * `autoStart`（默认 false）= 是否允许平台在**全员报到后自动开始**讨论链：
 * 多数用例只验证"排队/两态/通知"，开着自动链会把会议立刻跑完；验证"自动开始"的用例传 true。
 * 注意必须在 `composeServices` **之前**设置。
 */
async function setup(
  opts: { autoStart?: boolean; autoClose?: boolean } = {},
): Promise<{ pid: string; team: TeamMemberConfig[] }> {
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  config.meeting = { autoStart: opts.autoStart ?? false, autoClose: opts.autoClose ?? false }
  svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'queue', workdir, team: [{ roleTemplateId: 'pm' }, { roleTemplateId: 'dev' }, { roleTemplateId: 'qa' }] },
  })
  const p = res.json().project
  return { pid: p.id, team: p.team as TeamMemberConfig[] }
}

async function meetingsOf(pid: string): Promise<MeetingUi[]> {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/meetings` })
  return res.json().meetings as MeetingUi[]
}

async function waitFor(fn: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('会议：同一时刻只允许一个进行，其余排队等待', () => {
  it('两态呈现：进行中的会议 displayState=进行中；排队中的 waiting=true；结束后=已结束', async () => {
    const { pid, team } = await setup()
    const pm = team.find((t) => t.roleTemplateId === 'pm')!.instanceId
    const dev = team.find((t) => t.roleTemplateId === 'dev')!.instanceId
    const qa = team.find((t) => t.roleTemplateId === 'qa')!.instanceId

    // 第一个会议：占槽（内部 proposed），呈现仍是「进行中」
    const first = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: pm, topic: 'm1', members: [dev] },
    })
    expect(first.json().meeting.displayState).toBe('进行中')
    expect(first.json().meeting.waiting).toBe(false)
    const mid1 = first.json().meeting.id

    // 第二个会议：已有会议进行 → 排队等待
    const second = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings`,
      payload: { host: qa, topic: 'm2', members: [pm] },
    })
    expect(second.json().meeting.state).toBe('queued')
    expect(second.json().meeting.displayState).toBe('进行中') // 两态里没有"排队"
    expect(second.json().meeting.waiting).toBe(true)
    const mid2 = second.json().meeting.id

    const list = await meetingsOf(pid)
    expect(list.find((m) => m.id === mid1)!.displayState).toBe('进行中')
    expect(list.find((m) => m.id === mid2)!.waiting).toBe(true)

    // 结束第一个 → 第二个自动提升并开始（presentation 仍为进行中、waiting 转 false）
    // 注意：close 只接受 open/blocked，先把第一个会议接受成 open
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid1}/respond`,
      payload: { member: dev, decision: 'accept' },
    })
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/meetings/${mid1}/close`,
      payload: { actor: 'user' },
    })
    expect((await meetingsOf(pid)).find((m) => m.id === mid1)!.displayState).toBe('已结束')
    const promoted = (await meetingsOf(pid)).find((m) => m.id === mid2)!
    expect(promoted.state).not.toBe('queued')
    expect(promoted.waiting).toBe(false)
    expect(promoted.displayState).toBe('进行中')
  }, 30000)

  it('角色在有会议进行时发起 → 工具回执明确"已排队等待"，并提示不要重试', async () => {
    const { pid, team } = await setup()
    const pm = team.find((t) => t.roleTemplateId === 'pm')!
    const dev = team.find((t) => t.roleTemplateId === 'dev')!
    const qa = team.find((t) => t.roleTemplateId === 'qa')!

    // 先占槽：一个进行中的会议
    await svc.meetings.create({
      projectId: pid,
      host: pm.instanceId,
      topic: '已有会议',
      desc: 'x',
      members: [dev.instanceId],
    })
    expect(await svc.meetings.hasActiveMeeting(pid)).toBe(true)

    // qa 想发起会议 → 排队等待
    const env = await buildToolEnv({ config, projectService: svc.projectService }, pid, qa.instanceId, {
      sessionId: `u_${qa.instanceId}`,
    })
    const res = await executeTool(
      'meeting_start',
      { topic: 'qa 想开的会', desc: '对齐', members: [dev.instanceId] },
      env,
    )
    expect(res.ok).toBe(true)
    const summary = String((res as { summary?: string }).summary ?? '')
    expect(summary).toContain('排队等待')
    expect(summary).toContain('只允许一个会议')

    // 排队期间**不占用**第二个槽位：activeCount 仍为 1（只有第一个会议占槽）
    const list = await meetingsOf(pid)
    const mine = list.find((m) => m.meeting.topic === 'qa 想开的会')!
    expect(mine.state).toBe('queued')
    expect(mine.waiting).toBe(true)
    // 只有 1 个会议占槽 → 不违反"同时只允许一个进行"
    expect(list.filter((m) => !m.waiting && m.displayState === '进行中')).toHaveLength(1)
  }, 30000)

  it('入会通知：被邀请者在自己的 user 会话收到系统消息（不唤醒回合）；排队轮到后再通知一次', async () => {
    const { pid, team } = await setup()
    const pm = team.find((t) => t.roleTemplateId === 'pm')!.instanceId
    const dev = team.find((t) => t.roleTemplateId === 'dev')!.instanceId
    const qa = team.find((t) => t.roleTemplateId === 'qa')!.instanceId

    // 占槽会议（pm 主持，dev 参加）
    const first = await svc.meetings.create({
      projectId: pid,
      host: pm,
      topic: '占槽会议',
      desc: 'x',
      members: [dev],
    })
    await svc.meetings.respond(pid, first.id, dev, 'accept')

    // dev 自己的 user 会话收到【会议邀请】（通知是后台发出的，等它落盘），且**没有被唤醒跑回合**
    await waitFor(async () => {
      const evts = await svc.sessionStore.readWindow(pid, `u_${dev}`, { limit: 100 })
      return evts.some((e) => String(e.content?.text ?? '').includes('【会议邀请】'))
    })
    const devEvts = await svc.sessionStore.readWindow(pid, `u_${dev}`, { limit: 100 })
    const invite = devEvts.find((e) => String(e.content?.text ?? '').includes('【会议邀请】'))
    expect(invite).toBeDefined()
    expect(invite!.sender).toBe('system')
    expect(String(invite!.content?.text)).toContain('占槽会议')
    // 邀请会唤醒它一次（否则空闲角色永远看不到邀请、主持人会一直等人）；
    // 它在 step 边界闸门处立刻停手，所以**只有 turn_start、没有后续干活**。
    const afterInvite = devEvts.filter((e) => (e.seq ?? 0) > (invite!.seq ?? 0))
    expect(afterInvite.some((e) => e.kind === 'tool_call')).toBe(false)
    expect(afterInvite.some((e) => e.kind === 'tool_result')).toBe(false)

    // 排队会议（qa 主持，pm 参加）→ 排队期间的通知要说明"排队等待"
    const second = await svc.meetings.create({
      projectId: pid,
      host: qa,
      topic: '排队会议',
      desc: 'y',
      members: [pm],
    })
    await svc.meetings.respond(pid, second.id, pm, 'accept')
    await waitFor(async () => {
      const evts = await svc.sessionStore.readWindow(pid, `u_${pm}`, { limit: 100 })
      return evts.some((e) => String(e.content?.text ?? '').includes('【会议邀请】'))
    })
    const pmEvts = await svc.sessionStore.readWindow(pid, `u_${pm}`, { limit: 100 })
    const pmInvite = String(
      pmEvts.find((e) => String(e.content?.text ?? '').includes('【会议邀请】'))?.content?.text ?? '',
    )
    expect(pmInvite).toContain('排队等待')

    // 排队会议轮到（第一个会议结束）→ 参会者收到【会议开始】通知
    await svc.meetings.close(pid, first.id, pm)
    const started = await waitFor(async () => {
      const evts = await svc.sessionStore.readWindow(pid, `u_${pm}`, { limit: 200 })
      return evts.some((e) => String(e.content?.text ?? '').includes('【会议开始】'))
    })
    expect(started).toBe(true)
  }, 60000)

  it('排队会议等槽位空出后自动开始：主持人开场发言写进会议会话', async () => {
    // 自动开始开、自动收尾关：由测试手动结束占槽会议，验证排队会议**轮到即自动开场**。
    const { pid, team } = await setup({ autoStart: true })
    const pm = team.find((t) => t.roleTemplateId === 'pm')!.instanceId
    const dev = team.find((t) => t.roleTemplateId === 'dev')!.instanceId
    const qa = team.find((t) => t.roleTemplateId === 'qa')!.instanceId

    const first = await svc.meetings.create({
      projectId: pid,
      host: pm,
      topic: '占槽会议',
      desc: 'x',
      members: [dev],
    })
    const second = await svc.meetings.create({
      projectId: pid,
      host: qa,
      topic: '排队会议',
      desc: 'y',
      members: [pm],
    })
    expect((await svc.meetings.list(pid)).find((m) => m.id === second.id)!.state).toBe('queued')
    // 排队期间会议**还没开始**：会议会话里只有 create 事件，没有任何角色发言
    const beforeStart = await svc.sessionStore.readWindow(pid, second.id, { limit: 100 })
    expect(beforeStart.some((e) => e.kind === 'message' && e.role === 'agent')).toBe(false)

    // 结束占槽会议 → 排队会议被提升；它的受邀成员（pm）报到后自动开场
    await svc.meetings.respond(pid, first.id, dev, 'accept') // 先接受 → open
    await svc.meetings.close(pid, first.id, pm)
    expect((await svc.meetings.list(pid)).find((m) => m.id === second.id)!.state).toBe('proposed')
    await svc.meetings.respond(pid, second.id, pm, 'accept') // pm 报到 → 触发自动开场

    const opened = await waitFor(async () => {
      const evts = await svc.sessionStore.readWindow(pid, second.id, { limit: 200 })
      return evts.some((e) => e.kind === 'message' && String(e.sender) === qa)
    })
    expect(opened).toBe(true)
    const evts = await svc.sessionStore.readWindow(pid, second.id, { limit: 200 })
    const text = evts.map((e) => String(e.content?.text ?? '')).join('\n')
    expect(text).toContain('会议开场')
  }, 60000)
})
