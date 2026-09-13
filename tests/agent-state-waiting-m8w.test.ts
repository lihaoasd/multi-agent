/**
 * 「工作中」与「等待你处理」不应同时出现（M8W，2026-09-12）。
 *
 * 用户反馈：角色左栏显示**工作中**，会话里却摆着一张待回答的提问卡片。
 * 根因：状态有两个推导来源，且两处优先级不一致——
 *  - `GET /agents` 按「有 pending 提问/审批 → waiting」推导；
 *  - 而 loop 回合开始无条件占用 `working`、回合结束只按 occupancy 广播 `agent.state`。
 * 于是只要一次回合在「已有待答提问」时被触发（例如任务/审批的系统消息把角色唤醒，
 * 它只能再问一次，只能挂起），左栏就会显示工作中，而卡片还在等用户。
 *
 * 修复后的语义：
 *  1) 待答提问/待批审批 = 角色处于「等待你处理」：此时被触发的新回合**不开工**（ack 消息、直接结束）；
 *  2) 状态推导收敛到单点（application/runtime-state.ts），HTTP 查询与 WS `agent.state` 共用；
 *     广播的回合结束状态也不再无视 pending 提问/审批。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

interface AgentStateEvent {
  type: string
  sessionId?: string
  payload?: { instanceId?: string; state?: string }
}

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('agent-state-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
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

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'agent-state', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

async function stateOf(pid: string, iid: string): Promise<string> {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
  const me = (res.json().agents as Array<{ instanceId: string; state: string }>).find(
    (a) => a.instanceId === iid,
  )
  return me!.state
}

describe('角色状态：待答提问/待批审批期间不得显示「工作中」', () => {
  it('有待答提问时被系统消息触发 → 不开工、状态保持 waiting（不再出现"工作中 + 提问卡片"）', async () => {
    const { pid, dev } = await setup()
    const sid = `u_${dev.instanceId}`

    // 1) 角色提问 → 卡片出现，角色进入「等待你处理」
    await svc.questions.ask({
      projectId: pid,
      sessionId: sid,
      asker: dev.instanceId,
      question: '要 A 还是 B？',
      kind: 'single',
      options: ['A', 'B'],
    })
    expect(await stateOf(pid, dev.instanceId)).toBe('waiting')

    // 2) 平台/其它角色用系统消息唤醒它（任务通知、审批回注等路径都会走到 sendUserMessage）
    const seen: AgentStateEvent[] = []
    const off = svc.bus.subscribe({
      projectId: pid,
      onEvent: (e) => {
        if (e.type === 'agent.state') seen.push(e as unknown as AgentStateEvent)
      },
    })
    await svc.sessionService.sendUserMessage(pid, sid, '【系统】任务栏有任务待你领取', {
      system: true,
    })
    // 回合在后台推进：让出事件循环，等它跑到自己的第一个 await（acquire working）之后再断言
    await new Promise((r) => setTimeout(r, 50))
    await svc.sessionService.whenIdle(pid, dev.instanceId)
    off()

    // 3) 关键断言：整个回合过程中都不能广播 working，状态自始至终是「等待你处理」
    const workingFrames = seen.filter((e) => e.payload?.state === 'working')
    expect(workingFrames).toEqual([])
    expect(await stateOf(pid, dev.instanceId)).toBe('waiting')

    // 4) 被唤醒的回合**没有真的开工**（没有写任何文件）
    const fsMod = await import('node:fs/promises')
    const entries = await fsMod.readdir(workdir).catch(() => [])
    expect(entries).toEqual([])
    // 用户的消息仍然落盘（不会丢），等角色解除等待后还能看到
    const evts = await svc.sessionStore.readWindow(pid, sid, { limit: 100 })
    expect(evts.some((e) => e.kind === 'message' && String(e.content?.text ?? '').includes('待你领取'))).toBe(true)
  }, 30000)

  it('待批审批与之同理：被触发的新回合同样不开工', async () => {
    const { pid, dev } = await setup()
    const sid = `u_${dev.instanceId}`
    await svc.approvals.request({
      projectId: pid,
      kind: 'command',
      actor: dev.instanceId,
      sessionId: sid,
      summary: '执行命令：git push',
    })
    expect(await stateOf(pid, dev.instanceId)).toBe('waiting')

    const seen: AgentStateEvent[] = []
    const off = svc.bus.subscribe({
      projectId: pid,
      onEvent: (e) => {
        if (e.type === 'agent.state') seen.push(e as unknown as AgentStateEvent)
      },
    })
    await svc.sessionService.sendUserMessage(pid, sid, '【系统】继续吧', { system: true })
    await new Promise((r) => setTimeout(r, 50))
    await svc.sessionService.whenIdle(pid, dev.instanceId)
    off()

    expect(seen.filter((e) => e.payload?.state === 'working')).toEqual([])
    expect(await stateOf(pid, dev.instanceId)).toBe('waiting')
  }, 30000)
})
