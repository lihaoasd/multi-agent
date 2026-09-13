/**
 * 会议与「等待你处理」的冲突处理（M8X，2026-09-12）。
 *
 * 用户定稿语义：
 *  1) 受邀入会 = 该角色手头的**待答提问作废、待批审批作废**（卡片消失）→ 徽标「会议中」；
 *  2) **等全员入会后**主持人再开场发起讨论；
 *  3) 散会时把「会议纪要 + 入会时被搁置的事项」**自动回注**给每个参会者并唤醒一轮，
 *     让角色带着会议结论继续推进任务（用户选择的"自动续跑"）。
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

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('meeting-shed-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  // 保留自动开始（验证"全员入会 → 主持人开场"），但关掉自动收尾：本文件由测试自己 close 控制节奏
  config.meeting = { autoStart: true, autoClose: false }
  svc = composeServices(config, join(base, 'roles'))
  app = await buildApp(svc)
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

async function setup(): Promise<{ pid: string; team: TeamMemberConfig[] }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'shed', workdir, team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'qa' }] },
  })
  const p = res.json().project
  return { pid: p.id, team: p.team as TeamMemberConfig[] }
}

/** 轮询等待条件成立（异步链在后台推进）。 */
async function waitFor(fn: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('会议与「等待你处理」冲突：入会搁置 → 散会回注', () => {
  it('受邀成员带着待答提问+待批审批入会 → 两者作废、卡片撤下、徽标会议中', async () => {
    const { pid, team } = await setup()
    const dev = team.find((t) => t.roleTemplateId === 'dev')!
    const qa = team.find((t) => t.roleTemplateId === 'qa')!
    const qaSid = `u_${qa.instanceId}`

    // 受邀成员 qa 带着一张待答卡片 + 一条待批审批（主持人 dev 不受影响）
    await svc.questions.ask({
      projectId: pid,
      sessionId: qaSid,
      asker: qa.instanceId,
      question: '要 A 还是 B？',
      kind: 'single',
      options: ['A', 'B'],
    })
    const approval = await svc.approvals.request({
      projectId: pid,
      kind: 'command',
      actor: qa.instanceId,
      sessionId: qaSid,
      summary: '执行命令：git push',
    })
    expect(await svc.questions.list(pid, { status: 'pending' })).toHaveLength(1)
    expect(await svc.approvals.list(pid, 'pending')).toHaveLength(1)

    // 前端撤卡片靠 question.answered（cancelled=true）
    const cancelledPushes: Array<Record<string, unknown>> = []
    const off = svc.bus.subscribe({
      projectId: pid,
      onEvent: (e) => {
        if (e.type === 'question.answered') cancelledPushes.push(e.payload as Record<string, unknown>)
      },
    })

    // 发起会议（平台代受邀成员 accept → 触发搁置）
    const devEnv = await buildToolEnv({ config, projectService: svc.projectService }, pid, dev.instanceId, {
      sessionId: `u_${dev.instanceId}`,
    })
    const started = await executeTool(
      'meeting_start',
      { topic: '接口对齐', desc: '对齐接口与验收口径', members: [qa.instanceId] },
      devEnv,
    )
    off()
    expect(started.ok, JSON.stringify(started)).toBe(true)

    // 1) 提问作废、审批作废（卡片消失、待办条随之清空）
    const pendingQ = await svc.questions.list(pid, { status: 'pending' })
    expect(pendingQ).toHaveLength(0)
    const cancelled = await svc.questions.list(pid, { status: 'cancelled' })
    expect(cancelled).toHaveLength(1)
    expect((await svc.approvals.get(pid, approval.id)).status).toBe('expired')
    expect(await svc.approvals.list(pid, 'pending')).toHaveLength(0)
    // 前端收到撤卡片推送（带作废标记）
    expect(cancelledPushes.some((p) => p.cancelled === true && p.questionId === cancelled[0]!.id)).toBe(
      true,
    )

    // 2) 角色已入会 → 徽标「会议中」（会议中优先于等待你处理）
    const meetingId = (await svc.meetings.list(pid))[0]!.id
    expect(
      await waitFor(async () => (await svc.occupancy.get(pid, qa.instanceId))?.activity === 'meeting'),
    ).toBe(true)
    const agents = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    const state = (agents.json().agents as Array<{ instanceId: string; state: string }>).find(
      (a) => a.instanceId === qa.instanceId,
    )!.state
    expect(state).toBe('meeting')

    // 3) 等全员入会后才开场：平台代 qa accept（搁置先行）→ 主持人开场发言写进会议会话
    const opened = await waitFor(async () => {
      const evts = await svc.sessionStore.readWindow(pid, meetingId, { limit: 1000 })
      return evts.some(
        (e) => e.kind === 'message' && e.role === 'agent' && String(e.sender) === dev.instanceId,
      )
    })
    expect(opened).toBe(true)
    // 开场时受邀成员已在会且无待处理项（hold 事件不应出现）
    const evts = await svc.sessionStore.readWindow(pid, meetingId, { limit: 1000 })
    const holds = evts.filter(
      (e) => e.kind === 'meeting_event' && (e.payload as { action?: string })?.action === 'hold',
    )
    expect(holds).toHaveLength(0)
  }, 60000)

  it('散会后把「纪要 + 被搁置事项」回注给参会者并唤醒一轮继续推进任务', async () => {
    const { pid, team } = await setup()
    const dev = team.find((t) => t.roleTemplateId === 'dev')!
    const qa = team.find((t) => t.roleTemplateId === 'qa')!
    const qaSid = `u_${qa.instanceId}`

    // 受邀成员 qa 带着待答提问入会（会被搁置）
    await svc.questions.ask({
      projectId: pid,
      sessionId: qaSid,
      asker: qa.instanceId,
      question: '要不要先做 A？',
      kind: 'confirm',
    })
    await svc.meetings.create({
      projectId: pid,
      host: dev.instanceId,
      topic: '范围对齐',
      desc: '对齐范围',
      members: [qa.instanceId],
    })
    const meetingId = (await svc.meetings.list(pid))[0]!.id
    // 成员入会（触发搁置）→ 会议 open（close 只接受 open/blocked）
    await svc.meetings.respond(pid, meetingId, qa.instanceId, 'accept')
    expect((await svc.meetings.list(pid))[0]!.state).toBe('open')
    // 搁置已发生
    expect(await svc.questions.list(pid, { status: 'cancelled' })).toHaveLength(1)

    // 直接关会（等价主持人收尾）→ 触发 onClosed 回注
    await svc.meetings.close(pid, meetingId, dev.instanceId)

    // 每个参会者的 user 会话都收到「会议结论」系统消息，并各自跑了一轮
    for (const m of [dev, qa]) {
      const sid = `u_${m.instanceId}`
      const got = await waitFor(async () => {
        const evts = await svc.sessionStore.readWindow(pid, sid, { limit: 200 })
        return evts.some((e) => String(e.content?.text ?? '').includes('【会议结论】'))
      })
      expect(got).toBe(true)
      const evts = await svc.sessionStore.readWindow(pid, sid, { limit: 200 })
      const wrap = evts.find((e) => String(e.content?.text ?? '').includes('【会议结论】'))!
      expect(wrap.sender).toBe('system')
      // 回注后角色确实被唤醒跑了一轮（本轮有 turn_start）
      const turnStarted = await waitFor(async () => {
        const now = await svc.sessionStore.readWindow(pid, sid, { limit: 200 })
        return now.some((e) => e.kind === 'turn_start' && (e.seq ?? 0) > (wrap.seq ?? 0))
      })
      expect(turnStarted).toBe(true)
    }

    // qa 的搁置清单被写进回注正文（它知道"当初在等用户回答什么"）
    const qaEvts = await svc.sessionStore.readWindow(pid, qaSid, { limit: 200 })
    const qaWrap = String(
      qaEvts.find((e) => String(e.content?.text ?? '').includes('【会议结论】'))?.content?.text ?? '',
    )
    expect(qaWrap).toContain('要不要先做 A？')
    expect(qaWrap).toContain('已作废')
    expect(qaWrap).toContain('继续推进你手上的任务')
  }, 60000)
})
