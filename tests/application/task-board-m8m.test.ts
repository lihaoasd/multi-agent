/**
 * 任务栏（M8M，2026-09-12）：发布 → 通知领取 → 完成回通知委派人。
 * 覆盖：发布即通知、claim（带/不带 id、非受派人、忙时任、幂等）、done/blocked 通知委派人、
 * WS task.updated 广播、槽位释放只通知不自动开工。
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

interface Frame {
  type: string
  projectId?: string
  sessionId?: string
  payload?: Record<string, unknown>
}

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('board-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  // 甲模式：product/pm 可发布任务到任务栏
  config = loadConfig({ dataDir: join(base, 'data'), task: { assignByAgent: true } }, base)
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

async function setup(): Promise<{ pid: string; dev: TeamMemberConfig; product: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'board',
      workdir,
      team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'product' }],
    },
  })
  const p = res.json().project
  const team = p.team as TeamMemberConfig[]
  return {
    pid: p.id,
    dev: team.find((t) => t.roleTemplateId === 'dev')!,
    product: team.find((t) => t.roleTemplateId === 'product')!,
  }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, {
    sessionId: `u_${iid}`,
  })

/** 读某会话日志（判断是否收到了系统通知）。 */
async function logTexts(pid: string, sid: string): Promise<string[]> {
  const res = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
  const events = res.json().events as Array<{ kind: string; content?: { text?: string } }>
  return events.filter((e) => e.kind === 'message').map((e) => String(e.content?.text ?? ''))
}

/** 轮询等待日志里出现某段文本（通知是异步唤醒回合写进去的）。 */
async function waitForLog(pid: string, sid: string, needle: string, ms = 6000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const texts = await logTexts(pid, sid)
    if (texts.some((t) => t.includes(needle))) return
    if (Date.now() - t0 > ms) throw new Error(`等待通知超时：${needle}；已有：${texts.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

/** 轮询等待日志里含某段文本的消息条数达到 n（用于"槽位释放再通知一次"这类计数断言）。 */
async function waitForLogCount(
  pid: string,
  sid: string,
  needle: string,
  n: number,
  ms = 6000,
): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const hits = (await logTexts(pid, sid)).filter((t) => t.includes(needle)).length
    if (hits >= n) return
    if (Date.now() - t0 > ms) throw new Error(`等待通知次数超时：${needle} ×${n}（当前 ${hits}）`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function waitForFrame(frames: Frame[], type: string, ms = 4000): Promise<Frame> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = frames.find((f) => f.type === type)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`未收到 ${type}；已收到: ${frames.map((f) => f.type).join(',') || '(无)'}`)
}

describe('任务栏：发布 → 通知领取 → 完成回通知委派人', () => {
  it('task_assign 发布 → 任务栏 todo（待领取）+ 通知受派人 + WS task.updated(published)', async () => {
    const { pid, dev, product } = await setup()
    const frames: Frame[] = []
    const socket = await ready().injectWS(`/ws?projectId=${pid}`)
    socket.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Frame))
    try {
      const res = await executeTool(
        'task_assign',
        { assignee: dev.instanceId, title: '实现登录接口', desc: '含边界处理' },
        await env(pid, product.instanceId),
      )
      expect(res.ok).toBe(true)
      expect(res.ok ? res.summary : '').toContain('已发布任务')
      expect(res.ok ? res.summary : '').toContain('待领取')

      const tasks = await svc.tasks.list(pid)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.state).toBe('todo') // 发布即待领取，不自动开工
      expect(tasks[0]!.creator).toBe(product.instanceId)

      // ① 通知受派人领取（系统消息，且是系统身份不是用户冒充）
      await waitForLog(pid, `u_${dev.instanceId}`, '任务栏有任务待你领取')

      // ② 任务栏实时广播
      const published = await waitForFrame(frames, 'task.updated')
      expect(published.payload?.action).toBe('published')
      expect(published.payload?.state).toBe('todo')
      expect(published.payload?.assignee).toBe(dev.instanceId)
    } finally {
      socket.terminate()
    }
  }, 20000)

  it('task_claim：领取（免 taskId 领最早一条）→ 进行中；非受派人/忙时被拒；重复领取幂等', async () => {
    const { pid, dev, product } = await setup()
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '任务A' },
      await env(pid, product.instanceId),
    )
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '任务B' },
      await env(pid, product.instanceId),
    )

    // 非受派人领取被拒
    const wrong = await executeTool('task_claim', {}, await env(pid, product.instanceId))
    expect(wrong.ok).toBe(false)

    // 受派人领取最早一条
    const claimed = await executeTool('task_claim', {}, await env(pid, dev.instanceId))
    expect(claimed.ok).toBe(true)
    expect(claimed.ok ? claimed.summary : '').toContain('任务A')
    expect(claimed.ok ? claimed.summary : '').toContain('进行中')

    // 幂等：再领同一条仍是进行中，不报错
    const t1 = (await svc.tasks.list(pid)).find((t) => t.title === '任务A')!
    const again = await executeTool(
      'task_claim',
      { taskId: t1.id },
      await env(pid, dev.instanceId),
    )
    expect(again.ok).toBe(true)

    // 手上有进行中任务 → 领第二条被拒（不静默排队开工）
    const busy = await executeTool('task_claim', {}, await env(pid, dev.instanceId))
    expect(busy.ok).toBe(false)
    expect(busy.ok ? '' : busy.reason).toMatch(/进行中任务|最早/)
    const t2 = (await svc.tasks.list(pid)).find((t) => t.title === '任务B')!
    expect(t2.state).toBe('todo')
  }, 20000)

  it('完成 → 任务栏状态更新 + 委派人收到通知（做接下来的安排）+ WS task.updated(done)', async () => {
    const { pid, dev, product } = await setup()
    const frames: Frame[] = []
    const socket = await ready().injectWS(`/ws?projectId=${pid}`)
    socket.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Frame))
    try {
      await executeTool(
        'task_assign',
        { assignee: dev.instanceId, title: '实现登录接口' },
        await env(pid, product.instanceId),
      )
      const t = (await svc.tasks.list(pid))[0]!
      await executeTool('task_claim', { taskId: t.id }, await env(pid, dev.instanceId))
      const done = await executeTool(
        'task_update',
        { taskId: t.id, state: 'done', note: '已完成并自测' },
        await env(pid, dev.instanceId),
      )
      expect(done.ok).toBe(true)

      // 任务栏状态
      expect((await svc.tasks.list(pid)).find((x) => x.id === t.id)!.state).toBe('done')
      // 委派人（product_1）被通知安排后续
      await waitForLog(pid, `u_${product.instanceId}`, '请据此安排后续')
      const texts = await logTexts(pid, `u_${product.instanceId}`)
      expect(texts.some((x) => x.includes('已完成（受派人 dev_1）'))).toBe(true)
      // WS 广播 done
      const t0 = Date.now()
      let hit: Frame | undefined
      while (Date.now() - t0 < 4000) {
        hit = frames.find((f) => f.type === 'task.updated' && f.payload?.state === 'done')
        if (hit) break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(hit).toBeTruthy()
    } finally {
      socket.terminate()
    }
  }, 20000)

  it('受阻 → 委派人同样收到通知；槽位释放只通知下一条，不自动开工', async () => {
    const { pid, dev, product } = await setup()
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '任务A' },
      await env(pid, product.instanceId),
    )
    await executeTool(
      'task_assign',
      { assignee: dev.instanceId, title: '任务B' },
      await env(pid, product.instanceId),
    )
    const t1 = (await svc.tasks.list(pid)).find((t) => t.title === '任务A')!
    await executeTool('task_claim', { taskId: t1.id }, await env(pid, dev.instanceId))
    // 受阻 → 通知委派人
    const blocked = await executeTool(
      'task_update',
      { taskId: t1.id, state: 'blocked', note: '等待接口文档' },
      await env(pid, dev.instanceId),
    )
    expect(blocked.ok).toBe(true)
    await waitForLog(pid, `u_${product.instanceId}`, '受阻')
    expect((await svc.tasks.list(pid)).find((x) => x.id === t1.id)!.state).toBe('blocked')

    // 解除受阻 → 重新开工 → 完成（blocked→todo→in_progress→done 合法）
    await svc.tasks.setState(pid, t1.id, 'todo', 'user')
    await svc.tasks.setState(pid, t1.id, 'in_progress', 'user')
    const before = (await logTexts(pid, `u_${dev.instanceId}`)).filter((t) =>
      t.includes('任务栏有任务待你领取'),
    ).length
    await svc.tasks.setState(pid, t1.id, 'done', 'user')
    // 槽位释放：任务B 仍是待领取（不自动开工），只再通知一次受派人
    const t2 = (await svc.tasks.list(pid)).find((t) => t.title === '任务B')!
    expect(t2.state).toBe('todo')
    await waitForLogCount(pid, `u_${dev.instanceId}`, '任务栏有任务待你领取', before + 1)
  }, 20000)
})
