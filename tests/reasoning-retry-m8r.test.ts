/**
 * 推理型模型"只思考不输出"的重试（M8R，2026-09-12）。
 *
 * 真实事故：deepseek-v4-flash 在补文档时把 completion 预算全花在 reasoning 上，
 * finish_reason=length、没有正文也没有工具调用 → 回合以平台兜底文本结束，
 * 角色既没交付也没上报任务状态。修复：识别"裸步"（有思考但无正文无工具调用）或
 * finish_reason=length → 用"直接输出/调用工具，不要再长篇推理"重试一次。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { AgentLoopRunner } from '../src/application/agent-loop/loop-runner.js'
import type { ChatMessage } from '../src/infra/model/provider.js'
import type { ModelGateway } from '../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>

beforeEach(async () => {
  base = await makeTempDir('reasoning-')
  workdir = join(base, 'workdir')
  await mkdir(workdir, { recursive: true })
  const config = loadConfig({ dataDir: join(base, 'data') }, base)
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
    payload: { name: 'reasoning', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

describe('推理吃满预算的重试', () => {
  it('只出思考 → 平台用"直接输出"重试一次并拿到正文', async () => {
    const { pid, dev } = await setup()
    const seen: ChatMessage[][] = []
    let call = 0
    const gateway = {
      async *streamChat(opts: { messages: ChatMessage[] }) {
        seen.push(opts.messages)
        call++
        if (call === 1) {
          // 第一次：只有推理（且被截断）
          yield { reasoning: '我想了很久……'.repeat(50) }
          yield { finishReason: 'length' }
          return
        }
        // 重试后：给出正文
        yield { content: '结论：方案已完成并交付 docs/tech-design.md。' }
      },
    } as unknown as ModelGateway

    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    const evt = await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'reasoning-retry',
    })

    expect(call).toBe(2) // 确实重试了一次
    // 重试提示进了第二次请求
    const second = JSON.stringify(seen[1] ?? [])
    expect(second).toContain('不要再写出长篇推理')
    expect(evt.content?.text ?? '').toContain('docs/tech-design.md')
    // 不再出现"只给出思考过程"的兜底文本
    expect(evt.content?.text ?? '').not.toContain('只给出了思考过程')
  }, 20000)

  it('重试也只出思考 → 给出平台兜底说明（不会静默）', async () => {
    const { pid, dev } = await setup()
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        yield { reasoning: '继续思考中…' }
        yield { finishReason: 'length' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    const evt = await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'reasoning-retry-fail',
    })
    expect(call).toBe(2) // 只重试一次
    expect(evt.content?.text ?? '').toContain('只给出了思考过程')
  }, 20000)

  it('正常有正文时不会触发重试', async () => {
    const { pid, dev } = await setup()
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        yield { content: '直接给结论。' }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({ store: svc.sessionStore, gateway, bus: svc.bus })
    const evt = await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'normal',
    })
    expect(call).toBe(1)
    expect(evt.content?.text).toBe('直接给结论。')
  }, 20000)
})
