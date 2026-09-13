/**
 * 会议入会：step 边界闸门（M9A，2026-09-13）。
 *
 * 用户定的流程：主持人发起 → 通知所有角色 → 主持人等全员入会 → 开场讨论；
 * 被邀请的角色在**每个 step 结束后**发现"我被叫去开会了" → 停下当前工作、报到、等主持人发话。
 *
 * 这里验证闸门本身（loop 层 + 真实邀请台账）：
 *  1) 角色干活干到一半被邀请 → 把**当前 step 跑完**就停（不跑收尾、不催任务状态），并落一条系统消息说明原因；
 *  2) 停手后**不再继续下一个 step**（模型不会被继续调用）；
 *  3) 会议会话内的发言不受闸门约束（那种回合本来就生在会议里）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeServices } from '../../src/application/composition.js'
import { loadConfig } from '../../src/shared/config.js'
import { AgentLoopRunner } from '../../src/application/agent-loop/loop-runner.js'
import { MeetingInviteStore } from '../../src/application/meeting/invite-store.js'
import { createFileStorage } from '../../src/infra/store/file-store.js'
import { StorageFacade } from '../../src/infra/store/project-store.js'
import type { ChatMessage, ToolSchema } from '../../src/infra/model/provider.js'
import type { ModelGateway } from '../../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

/** 测试用存储门面（重构 P1：store 不再吃 projectsRoot，改吃项目作用域门面）。 */
function makeFacade(projectsRoot: string): StorageFacade {
  const s = createFileStorage(projectsRoot)
  return new StorageFacade(s, s.root)
}

let base: string
let workdir: string
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>
let invites: MeetingInviteStore

beforeEach(async () => {
  base = await makeTempDir('meeting-yield-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  config.meeting = { autoStart: false, autoClose: false } // 只测闸门，不跑讨论链
  svc = composeServices(config, join(base, 'roles'))
  invites = new MeetingInviteStore(
    makeFacade(join(config.dataDir, 'projects')).forProjectsRoot(join(config.dataDir, 'projects')),
  )
})
afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined)
})

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig; qa: string }> {
  const p = await svc.projectService.create({ name: 'yield', workdir })
  await svc.teamService.add(p.id, { roleTemplateId: 'dev' })
  await svc.teamService.add(p.id, { roleTemplateId: 'qa' })
  const team = await svc.teamService.list(p.id)
  return {
    pid: p.id,
    dev: team.find((m) => m.roleTemplateId === 'dev')!,
    qa: team.find((m) => m.roleTemplateId === 'qa')!.instanceId,
  }
}

/** 只调一次 fs_list_dir 的网关：若闸门失效，它会一直被调用（calls 增长）。 */
function oneStepGateway(counter: { calls: number }): ModelGateway {
  return {
    async *streamChat(_opts: { messages: ChatMessage[] }) {
      counter.calls++
      yield { toolCall: { index: 0, id: `c${counter.calls}`, name: 'fs_list_dir' } }
      yield { toolCall: { index: 0, argumentsDelta: JSON.stringify({ path: 'workdir://' }) } }
    },
  } as unknown as ModelGateway
}

function loopWith(gateway: ModelGateway): AgentLoopRunner {
  return new AgentLoopRunner({
    store: svc.sessionStore,
    gateway,
    bus: svc.bus,
    occupancy: svc.occupancy,
    toolRuntime: {
      listTools: () => [{ name: 'fs_list_dir' }] as unknown as ToolSchema[],
      exec: async () => ({ ok: true, summary: '（目录列表）' }),
      activeTask: async (ctx) => {
        const list = await svc.tasks.list(ctx.projectId, {
          assignee: ctx.member.instanceId,
          state: 'in_progress',
        })
        const x = list[0]
        return x ? { id: x.id, title: x.title, desc: x.desc } : null
      },
      pendingTasks: async () => [],
      // 与组合根一致的闸门实现：被邀请但未入会 → 停手（会议会话内的发言不受约束）
      shouldYield: async (ctx) => {
        if (ctx.sessionId.startsWith('m_')) return null
        return (await invites.hasPendingInvite(ctx.projectId, ctx.member.instanceId))
          ? '【系统】你被拉进了一个会议：请立即停止手上的工作（任务保持当前状态）。'
          : null
      },
    },
  })
}

describe('step 边界闸门：被会议叫走时停下当前工作', () => {
  it('干活到一半被邀请 → 当前 step 跑完就停（不再调模型、不跑收尾、不催任务状态）', async () => {
    const { pid, dev, qa } = await setup()
    const sid = `u_${dev.instanceId}`
    const counter = { calls: 0 }

    // dev 有一条进行中任务（用于验证"不催任务状态"）
    const created = await svc.tasks.create({
      projectId: pid,
      title: '写登录接口',
      creator: 'user',
      assignee: dev.instanceId,
    })
    await svc.tasks.claim(pid, dev.instanceId, created.task.id)

    // 平台记录"dev 被会议邀请、尚未入会" → 闸门条件成立
    const meeting = await svc.meetings.create({
      projectId: pid,
      host: qa,
      topic: '临时评审',
      desc: 'x',
      members: [dev.instanceId],
    })
    await invites.invite(pid, meeting.id, dev.instanceId)

    await loopWith(oneStepGateway(counter)).runDirectTurn({
      projectId: pid,
      sessionId: sid,
      member: dev,
      scenario: 'yield',
    })

    // 1) 只跑了 1 步：第 1 步工具执行完就被闸门拦下
    expect(counter.calls).toBe(1)

    const evts = await svc.sessionStore.readWindow(pid, sid, { limit: 200 })
    const texts = evts.map((e) => String(e.content?.text ?? ''))
    // 2) 落了一条系统消息说明"被拉进会议、停手"
    expect(texts.some((t) => t.includes('被拉进了一个会议') && t.includes('停止手上的工作'))).toBe(true)
    // 3) 不跑收尾回合、也不催任务状态（任务是暂停，不是完成）
    expect(texts.some((t) => t.includes('收尾') || t.includes('仍为进行中'))).toBe(false)
    // 4) 任务保持进行中（平台不替角色改状态）
    expect((await svc.tasks.list(pid)).find((t) => t.id === created.task.id)!.state).toBe('in_progress')
  }, 30000)

  it('没有会议邀请时闸门不生效：正常多步干活', async () => {
    const { pid, dev } = await setup()
    const counter = { calls: 0 }
    await loopWith(oneStepGateway(counter)).runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'no-invite',
    })
    // 没有邀请 → 闸门永远返回 null → 最多 3 次后触发无进展保护（证明它确实跑了很多步）
    expect(counter.calls).toBeGreaterThan(1)
  }, 30000)

  it('会议会话内的发言不受闸门约束（它本来就生在会议里）', async () => {
    const { pid, dev, qa } = await setup()
    const counter = { calls: 0 }
    const meeting = await svc.meetings.create({
      projectId: pid,
      host: qa,
      topic: '进行中的会',
      desc: 'x',
      members: [dev.instanceId],
    })
    // 即使台账里有该角色的未入会邀请，会议会话内的回合也不能被拦（否则会议永远说不下去）
    await invites.invite(pid, meeting.id, dev.instanceId)
    await loopWith(oneStepGateway(counter)).runDirectTurn({
      projectId: pid,
      sessionId: meeting.id,
      member: dev,
      scenario: 'in-meeting',
    })
    expect(counter.calls).toBeGreaterThan(1)
  }, 30000)
})
