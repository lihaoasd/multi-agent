/**
 * 提问推送（M8L）：`ask_user` 落盘后经 WebSocket 即时下行 `question.asked`，
 * 前端据此在**对应角色会话**零请求渲染卡片（不再依赖轮询）。
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
  base = await makeTempDir('qpush-')
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

async function setupProject(): Promise<{ pid: string; dev: TeamMemberConfig }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'qpush', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  const dev = (p.team as TeamMemberConfig[]).find((t) => t.roleTemplateId === 'dev')!
  return { pid: p.id, dev }
}

/** 轮询等待某类 WS 帧到达（不依赖具体延迟）。 */
async function waitForType(frames: Frame[], type: string, ms = 3000): Promise<Frame> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = frames.find((f) => f.type === type)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`未收到 ${type}；已收到: ${frames.map((f) => f.type).join(',') || '(无)'}`)
}

describe('提问推送（WS question.asked / question.answered）', () => {
  it('落盘后推送 question.asked（带提问角色会话 sessionId 与完整记录）；回答后推 question.answered', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`
    const frames: Frame[] = []
    const socket = await ready().injectWS(`/ws?projectId=${pid}`)
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(String(raw)) as Frame)
    })
    try {
      const rec = (
        await svc.questions.ask({
          projectId: pid,
          sessionId: sid,
          asker: dev.instanceId,
          question: '要 A 还是 B？',
          kind: 'single',
          options: ['A', 'B'],
        })
      ).record

      const asked = await waitForType(frames, 'question.asked')
      // 事件归属 = 提问所在角色会话 → 前端可立即在该会话渲染卡片
      expect(asked.projectId).toBe(pid)
      expect(asked.sessionId).toBe(sid)
      expect(asked.payload?.questionId).toBe(rec.id)
      const pushed = asked.payload?.record as { id: string; status: string; options: string[] }
      expect(pushed.id).toBe(rec.id)
      expect(pushed.status).toBe('pending')
      expect(pushed.options).toEqual(['A', 'B'])

      await svc.questions.answer(pid, rec.id, { choice: 'A' })
      const answered = await waitForType(frames, 'question.answered')
      expect(answered.sessionId).toBe(sid)
      expect(answered.payload?.questionId).toBe(rec.id)
    } finally {
      socket.terminate()
    }
  }, 20000)

  it('项目过滤：订阅别的 projectId 的连接收不到本项目的提问推送', async () => {
    const { pid, dev } = await setupProject()
    const got: string[] = []
    const off = svc.bus.subscribe({ projectId: 'p_someone_else', onEvent: (e) => got.push(e.type) })
    await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      question: '确认？',
      kind: 'confirm',
    })
    off()
    expect(got).not.toContain('question.asked')
  }, 20000)

  it('同一会话已有待答问题时再次提问 → 进排队队列；同一问题重复提问 → 去重（都不推送）', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`
    const frames: Frame[] = []
    const socket = await ready().injectWS(`/ws?projectId=${pid}`)
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(String(raw)) as Frame)
    })
    try {
      await svc.questions.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '第一次问？',
        kind: 'confirm',
      })
      await waitForType(frames, 'question.asked')
      // 不同问题 → 排队（不推送，等用户答完上一个再弹）
      const second = await svc.questions.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '第二次问？',
        kind: 'confirm',
      })
      expect(second.record.status).toBe('queued')
      // 同一问题（文本归一化相同）→ 去重，返回既有记录，不新建、不推送
      const dup = await svc.questions.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: ' 第一次问？ ',
        kind: 'confirm',
      })
      expect(dup.duplicate).toBe(true)
      expect(await svc.questions.list(pid, { status: 'pending' })).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 120))
      expect(frames.filter((f) => f.type === 'question.asked')).toHaveLength(1)
    } finally {
      socket.terminate()
    }
  }, 20000)
})
