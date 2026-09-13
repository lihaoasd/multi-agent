import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import {
  AgentLoopRunner,
  type ToolRuntimeHook,
  type TurnContext,
} from '../../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../../src/infra/tools/executor.js'
import type { ChatMessage, ToolSchema } from '../../src/infra/model/provider.js'
import type { ModelGateway } from '../../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../../src/shared/types/project.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('ask-')
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
    payload: {
      name: 'ask',
      workdir,
      team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'product' }],
    },
  })
  const p = res.json().project
  const dev = (p.team as TeamMemberConfig[]).find((t) => t.roleTemplateId === 'dev')!
  return { pid: p.id, dev }
}

/** 假网关：第一轮调用 ask_user，第二轮给出收尾文本。 */
function askGateway(argsDelta: string, calls: ChatMessage[][] = []): ModelGateway {
  let i = 0
  return {
    async *streamChat(opts: { messages: ChatMessage[] }) {
      calls.push(opts.messages)
      i++
      if (i === 1) {
        yield { content: '这需要你拍板。' }
        yield { toolCall: { index: 0, id: 'call_ask', name: 'ask_user' } }
        yield { toolCall: { index: 0, argumentsDelta: argsDelta } }
      } else {
        yield { content: '已向你提问，等你回答后继续。' }
      }
    },
  } as unknown as ModelGateway
}

/** 真实注册表派生的工具运行时（注入 sessionId，与 composition 一致）。 */
function toolRuntime(): ToolRuntimeHook {
  return {
    listTools: (ctx, sessionType) => {
      const allowed = new Set(ctx.member.tools ?? [])
      return listToolDefs()
        .filter(
          (d) =>
            d.availableIn.includes(sessionType) &&
            (allowed.has(d.name) || (sessionType === 'user' && d.name === 'ask_user')),
        )
        .map((d): ToolSchema => ({
          name: d.name,
          description: d.description,
          parameters: d.paramsSchema ?? { type: 'object', properties: {} },
        }))
    },
    exec: async (ctx, sessionType, name, args) =>
      executeTool(
        name,
        args,
        await buildToolEnv(
          { config, projectService: svc.projectService },
          ctx.projectId,
          ctx.member.instanceId,
          { sessionId: ctx.sessionId, sessionType: sessionType === 'meeting' ? 'meeting' : 'user' },
        ),
      ),
    maxSteps: 4,
  }
}

function turnCtx(pid: string, dev: TeamMemberConfig): TurnContext {
  return { projectId: pid, sessionId: `u_${dev.instanceId}`, member: dev, scenario: 'ask' }
}

describe('问题服务：单选/多选/确认/文本 校验', () => {
  it('kind 与选项校验、重复回答与并发提问被拒', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`
    const qs = svc.questions

    // single 选项不足
    await expect(
      qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '选哪个？',
        kind: 'single',
        options: ['A'],
      }),
    ).rejects.toThrow(/至少 2 个选项/)
    // 非法 kind
    await expect(
      qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: 'x',
        kind: 'nope',
      }),
    ).rejects.toThrow(/kind/)

    // 正常发起 single → 答完（后续问题才能成为"待答"）
    const q1 = (
      await qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '先做 A 还是 B？',
        kind: 'single',
        options: ['A', 'B'],
      })
    ).record
    // 选项不在候选内
    await expect(qs.answer(pid, q1.id, { choice: 'C' })).rejects.toThrow(/不在候选/)
    const a1 = (await qs.answer(pid, q1.id, { choice: 'A' })).question
    expect(a1.status).toBe('answered')
    // 重复回答
    await expect(qs.answer(pid, q1.id, { choice: 'B' })).rejects.toThrow(/已处理/)

    // multi：空选与越界被拒，正常通过
    const q2 = (
      await qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '要包含哪些？',
        kind: 'multi',
        options: ['日志', '监控', '备份'],
      })
    ).record
    await expect(qs.answer(pid, q2.id, { choices: [] })).rejects.toThrow(/至少选择 1 项/)
    await expect(qs.answer(pid, q2.id, { choices: ['日志', '告警'] })).rejects.toThrow(/不在候选/)
    const a2 = (await qs.answer(pid, q2.id, { choices: ['日志', '备份'], text: '先做这两个' }))
      .question
    expect(a2.answer?.choices).toEqual(['日志', '备份'])
    expect(a2.answer?.text).toBe('先做这两个')

    // text：必须填内容
    const q3 = (
      await qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '项目代号叫什么？',
        kind: 'text',
      })
    ).record
    await expect(qs.answer(pid, q3.id, { text: '  ' })).rejects.toThrow(/请输入回答内容/)
    const a3 = (await qs.answer(pid, q3.id, { text: '贪吃蛇-v1' })).question
    expect(a3.answer?.text).toBe('贪吃蛇-v1')

    // confirm 缺省选项
    const q4 = (
      await qs.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '按基线开工？',
      })
    ).record
    expect(q4.kind).toBe('confirm')
    expect(q4.options).toEqual(['确认', '取消'])

    // 排队与"同一问题不重复问"（放在最后，避免影响上面的"立即待答"断言）
    const queued = await qs.ask({
      projectId: pid,
      sessionId: sid,
      asker: dev.instanceId,
      question: '再来一个？',
    })
    expect(queued.record.status).toBe('queued') // 已有待答 → 排队而非报错
    const dupQueued = await qs.ask({
      projectId: pid,
      sessionId: sid,
      asker: dev.instanceId,
      question: '  再来一个？ ',
    })
    expect(dupQueued.duplicate).toBe(true)
    expect(dupQueued.record.id).toBe(queued.record.id)
    const dupPending = await qs.ask({
      projectId: pid,
      sessionId: sid,
      asker: dev.instanceId,
      question: '按基线开工？',
      kind: 'confirm',
    })
    expect(dupPending.duplicate).toBe(true)
    expect(dupPending.record.id).toBe(q4.id)
    expect(await qs.list(pid, { status: 'pending' })).toHaveLength(1)
    expect(await qs.list(pid, { status: 'queued' })).toHaveLength(1)
  })

  it('回答后自动推进队列：下一个排队问题变成待答并推送', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`
    const qs = svc.questions
    const asked: string[] = []
    const off = svc.bus.subscribe({
      projectId: pid,
      sessionId: sid,
      onEvent: (e) => {
        if (e.type === 'question.asked') asked.push(String(e.payload?.questionId ?? ''))
      },
    })
    const q1 = (
      await qs.ask({ projectId: pid, sessionId: sid, asker: dev.instanceId, question: '第 1 问？' })
    ).record
    const q2 = (
      await qs.ask({ projectId: pid, sessionId: sid, asker: dev.instanceId, question: '第 2 问？' })
    ).record
    expect(q1.status).toBe('pending')
    expect(q2.status).toBe('queued')
    expect(asked).toEqual([q1.id]) // 排队中的不推送

    const r1 = await qs.answer(pid, q1.id, { choice: '确认' })
    expect(r1.question.status).toBe('answered')
    expect(r1.next?.id).toBe(q2.id) // 队首被提升
    expect((await qs.get(pid, q2.id)).status).toBe('pending')
    expect(asked).toEqual([q1.id, q2.id]) // 下一张卡片立即推送

    const r2 = await qs.answer(pid, q2.id, { choice: '确认' })
    expect(r2.next).toBeNull() // 队列空了 → 调用方可以唤醒角色
    off()
  })
})

describe('Agent 提问 → 用户回答 → Agent 继续（全链路）', () => {
  it('工具调用落 pending 提问、计入需你处理；回答后写回会话并触发新回合', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway: askGateway(
        JSON.stringify({
          question: '登录用手机号还是邮箱？',
          kind: 'single',
          options: ['手机号', '邮箱'],
          allowText: true,
        }),
      ),
      bus: svc.bus,
      toolRuntime: toolRuntime(),
    })
    await loop.runDirectTurn(turnCtx(pid, dev))

    // 1) pending 提问 + 审计事件
    const listRes = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/questions?status=pending`,
    })
    const pending = listRes.json().questions as Array<{
      id: string
      kind: string
      options: string[]
    }>
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('single')
    expect(pending[0]!.options).toEqual(['手机号', '邮箱'])
    const qid = pending[0]!.id

    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    ).json().events as Array<{ kind: string; payload?: Record<string, unknown> }>
    const call = evts.find((e) => e.kind === 'tool_call')
    expect(call?.payload?.tool).toBe('ask_user')
    const result = evts.find((e) => e.kind === 'tool_result')
    expect(result?.payload?.ok).toBe(true)
    expect(String(result?.payload?.summary ?? '')).toContain(qid)

    // 2) 计入「需你处理」
    const att = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/needs-attention` })
    const items = att.json().items as Array<{ kind: string; questionId?: string }>
    expect(items.some((i) => i.kind === 'question' && i.questionId === qid)).toBe(true)

    // 3) 非法选项被拒
    const bad = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/questions/${qid}/answer`,
      payload: { choice: '微信' },
    })
    expect(bad.statusCode).toBe(400)

    // 4) 正常回答 → 答复写回会话 + 触发 Agent 回合（Mock）
    const ans = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/questions/${qid}/answer`,
      payload: { choice: '手机号', text: '海外用户后续再说' },
    })
    expect(ans.statusCode).toBe(200)
    expect(ans.json().question.status).toBe('answered')
    expect(ans.json().wakeError).toBeNull()

    // 答复写回会话，并且**触发新的 Agent 回合**（异步，轮询等待第二轮 turn_end）
    const deadline = Date.now() + 8000
    let after: Array<{ kind: string; role?: string; content?: { text?: string } }> = []
    for (;;) {
      after = (
        await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
      ).json().events as typeof after
      if (after.filter((e) => e.kind === 'turn_end').length >= 2) break
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 30))
    }
    const answerMsg = after.find(
      (e) =>
        e.kind === 'message' &&
        e.role === 'user' &&
        String(e.content?.text ?? '').includes('【回答提问'),
    )
    expect(answerMsg).toBeTruthy()
    expect(String(answerMsg!.content?.text)).toContain('手机号')
    expect(String(answerMsg!.content?.text)).toContain('海外用户后续再说')
    expect(after.filter((e) => e.kind === 'turn_end').length).toBeGreaterThanOrEqual(2)

    // 5) 回答后不再有 pending
    const list2 = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/questions?status=pending`,
    })
    expect(list2.json().questions).toHaveLength(0)
  }, 20000)

  it('多选与文本答复写回会话的用户消息格式正确', async () => {
    const { pid, dev } = await setupProject()
    const sid = `u_${dev.instanceId}`
    const q = (
      await svc.questions.ask({
        projectId: pid,
        sessionId: sid,
        asker: dev.instanceId,
        question: '要包含哪些模块？',
        kind: 'multi',
        options: ['需求', '设计', '开发'],
      })
    ).record
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/questions/${q.id}/answer`,
      payload: { choices: ['需求', '开发'] },
    })
    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/${sid}/log` })
    ).json().events as Array<{ kind: string; role?: string; content?: { text?: string } }>
    const msg = evts.find(
      (e) =>
        e.kind === 'message' &&
        e.role === 'user' &&
        String(e.content?.text ?? '').includes('【回答提问'),
    )
    expect(String(msg?.content?.text)).toContain('需求、开发')
  }, 20000)
})
