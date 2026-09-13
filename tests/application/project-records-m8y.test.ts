import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('records-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  config = loadConfig({ dataDir: join(base, 'data') }, base)
  config.roleDirs = [BUILTIN_DIR, join(base, 'roles')]
  // 本文件要断言"进行中/已结束"两种会议记录 → 关掉自动开始/自动收尾，由测试自己控制会议生死
  config.meeting = { autoStart: false, autoClose: false }
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

interface RecordCard {
  id: string
  kind: 'task' | 'meeting'
  title: string
  by: string
  at: string
  note?: string
  taskState?: string
  meetingState?: string
  sessionId?: string
}

async function setup(): Promise<{ pid: string; dev: string; qa: string }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'records', workdir, team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'qa' }] },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    dev: team.find((t) => t.roleTemplateId === 'dev')!.instanceId,
    qa: team.find((t) => t.roleTemplateId === 'qa')!.instanceId,
  }
}

async function recordsOf(pid: string): Promise<RecordCard[]> {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/records` })
  return res.json().records as RecordCard[]
}

describe('项目记录（GET /records）：任务完成 + 会议 的卡片流', () => {
  it('收录终态任务与会议（进行中/已结束）；排除取消的会议；带完成总结与来源会话；按时间倒序', async () => {
    const { pid, dev, qa } = await setup()

    // 1) 一条进行中任务（不应收录；挂 qa，避免占用 dev 的单工槽位）
    const t1 = await svc.tasks.create({ projectId: pid, title: '进行中的事', creator: 'user', assignee: qa })
    await svc.tasks.claim(pid, qa, t1.task.id)

    // 2) 一条完成任务（带完成总结）
    const t2 = await svc.tasks.create({ projectId: pid, title: '写登录接口', creator: 'user', assignee: dev })
    await svc.tasks.claim(pid, dev, t2.task.id)
    await svc.tasks.setState(pid, t2.task.id, 'done', dev, '已实现并通过 3 个用例')

    // 3) 一条终止任务（dev 的完成已释放单工槽位，可再领取后终止；qa 手上仍有进行中任务）
    const t3 = await svc.tasks.create({ projectId: pid, title: '被砍掉的需求', creator: 'user', assignee: dev })
    await svc.tasks.claim(pid, dev, t3.task.id)
    await svc.tasks.setState(pid, t3.task.id, 'terminated', dev, '方向变更，停止')

    // 4) 未结束会议（不应收录）——它占着槽位
    const m1 = await svc.meetings.create({
      projectId: pid,
      host: dev,
      topic: '还没结束的会',
      desc: 'x',
      members: [qa],
    })
    expect((await svc.meetings.list(pid)).find((m) => m.id === m1.id)!.state).toBe('proposed')

    // 5) 已结束会议（收录）：取消占槽会议让它转 proposed → accept → close
    const m2 = await svc.meetings.create({
      projectId: pid,
      host: dev,
      topic: '接口方案评审',
      desc: '对齐登录接口字段',
      members: [qa],
    })
    expect((await svc.meetings.list(pid)).find((m) => m.id === m2.id)!.state).toBe('queued')
    await svc.meetings.cancel(pid, m1.id, dev) // 槽位空出 → m2 自动转 proposed
    expect((await svc.meetings.list(pid)).find((m) => m.id === m2.id)!.state).toBe('proposed')
    await svc.meetings.respond(pid, m2.id, qa, 'accept')
    await svc.meetings.close(pid, m2.id, dev)

    const list = await recordsOf(pid)
    // 收录 3 条：done/terminated 任务 + 已结束会议（m1 被取消 → 不作记录；进行中会议见下一个用例）
    expect(list).toHaveLength(3)
    expect(list.some((r) => r.id === t1.task.id)).toBe(false)
    expect(list.some((r) => r.id === m1.id)).toBe(false) // m1 已被取消 → 不作记录

    const task = list.find((r) => r.id === t2.task.id)!
    expect(task.kind).toBe('task')
    expect(task.title).toBe('写登录接口')
    expect(task.by).toBe(dev)
    expect(task.note).toBe('已实现并通过 3 个用例')
    expect(task.taskState).toBe('done')
    expect(task.sessionId).toBe(`u_${dev}`) // 一键跳源的会话

    const term = list.find((r) => r.id === t3.task.id)!
    expect(term.taskState).toBe('terminated')
    expect(term.note).toBe('方向变更，停止')

    const meeting = list.find((r) => r.id === m2.id)!
    expect(meeting.kind).toBe('meeting')
    expect(meeting.title).toBe('接口方案评审')
    expect(meeting.by).toBe(dev)
    expect(meeting.sessionId).toBe(m2.id)
    expect(meeting.at).not.toBe('')
    // 会议只有两态：已结束 / 进行中
    expect(meeting.meetingState).toBe('已结束')

    // 时间倒序（会议最后完成 → 排最前）
    expect(list[0]!.id).toBe(m2.id)
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.at >= list[i]!.at).toBe(true)
    }
  }, 30000)

  it('进行中的会议也出现在记录里（两态：进行中/已结束）', async () => {
    const { pid, dev, qa } = await setup()
    await svc.meetings.create({
      projectId: pid,
      host: dev,
      topic: '正在开的会',
      desc: '还没结束',
      members: [qa],
    })
    const list = await recordsOf(pid)
    expect(list).toHaveLength(1)
    expect(list[0]!.kind).toBe('meeting')
    expect(list[0]!.meetingState).toBe('进行中')
  }, 20000)

  it('空项目返回空数组（前端显示"暂无记录"）', async () => {
    const { pid } = await setup()
    expect(await recordsOf(pid)).toEqual([])
  }, 20000)
})
