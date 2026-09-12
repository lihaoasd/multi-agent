/**
 * 问题列表（M8U，2026-09-12）：**一次 ask_user 带一组问题**，用户在一张卡片里一次答完。
 *
 * 背景：用户实测发现模型想一次问 3 件事时，会并发发 3 个 ask_user 调用（后两个被规则挡掉/丢弃，
 * 看起来像"同一个问题问了三次"）。正确形态是**一个问题列表**：
 *   - 一次调用传 `questions: [...]`（1..6 题）；
 *   - 平台落成**一条**提问记录（一条 pending，卡片里逐题呈现）；
 *   - 用户一次提交全部答案（`{answers:[{itemId,choice/choices/text}]}`，每题必答）；
 *   - 角色在一轮里只被唤醒一次。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import { AgentLoopRunner } from '../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../src/infra/tools/executor.js'
import { QuestionService } from '../src/application/question/question-service.js'
import type { ToolSchema } from '../src/infra/model/provider.js'
import type { ModelGateway } from '../src/infra/model/gateway.js'
import type { TeamMemberConfig } from '../src/shared/types/project.js'
import { makeTempDir } from './helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  base = await makeTempDir('qlist-')
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
    payload: { name: 'qlist', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

describe('问题列表：一次调用问多件事', () => {
  it('ask(items) → 只落 1 条记录、items=3、status=pending、摘要是「共 3 个问题」', async () => {
    const { pid, dev } = await setup()
    const { record } = await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      questions: [
        { question: '目标平台选哪个？', kind: 'single', options: ['Web', '桌面'] },
        { question: '要包含哪些功能？', kind: 'multi', options: ['难度', '音效'] },
        { question: '技术栈偏好？', kind: 'text' },
      ],
    })
    expect(record.items).toHaveLength(3)
    expect(record.status).toBe('pending')
    expect(record.question).toBe('共 3 个问题')
    expect(record.items[0]!.kind).toBe('single')
    expect(record.items[2]!.kind).toBe('text')
    expect(record.items[0]!.id).not.toBe(record.items[1]!.id)
    // 待答只有 1 条（不是 3 条）
    expect(await svc.questions.list(pid, { status: 'pending' })).toHaveLength(1)
  }, 20000)

  it('问题列表必须每题都答；缺一题报明确错误、且不落盘为已答', async () => {
    const { pid, dev } = await setup()
    const { record } = await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      questions: [
        { question: 'A 还是 B？', kind: 'single', options: ['A', 'B'] },
        { question: '补充代号？', kind: 'text' },
      ],
    })
    await expect(
      svc.questions.answer(pid, record.id, {
        answers: [{ itemId: record.items[0]!.id, choice: 'A' }],
      }),
    ).rejects.toThrow(/第 2 题还没回答/)
    expect((await svc.questions.get(pid, record.id)).status).toBe('pending')
  }, 20000)

  it('一次提交全部答案 → answered，逐题答案正确，答复文本逐条列出', async () => {
    const { pid, dev } = await setup()
    const { record } = await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      questions: [
        { question: '目标平台选哪个？', kind: 'single', options: ['Web', '桌面'] },
        { question: '要包含哪些功能？', kind: 'multi', options: ['难度', '音效'] },
        { question: '技术栈偏好？', kind: 'text' },
      ],
    })
    const [i1, i2, i3] = record.items
    const r = await svc.questions.answer(pid, record.id, {
      answers: [
        { itemId: i1!.id, choice: 'Web' },
        { itemId: i2!.id, choices: ['难度', '音效'] },
        { itemId: i3!.id, text: '原生 JS' },
      ],
    })
    expect(r.question.status).toBe('answered')
    expect(r.question.items[0]!.answer?.choice).toBe('Web')
    expect(r.question.items[1]!.answer?.choices).toEqual(['难度', '音效'])
    expect(r.question.items[2]!.answer?.text).toBe('原生 JS')
    const text = QuestionService.answerText(r.question)
    expect(text).toContain('共 3 个问题')
    expect(text).toContain('1) 目标平台选哪个？')
    expect(text).toContain('→ Web')
    expect(text).toContain('→ 难度、音效')
    expect(text).toContain('→ 原生 JS')
  }, 20000)

  it('选项校验按题定位（第 2 题的越界选项会被点名）', async () => {
    const { pid, dev } = await setup()
    const { record } = await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      questions: [
        { question: 'A 还是 B？', kind: 'single', options: ['A', 'B'] },
        { question: '要哪些？', kind: 'multi', options: ['x', 'y'] },
      ],
    })
    await expect(
      svc.questions.answer(pid, record.id, {
        answers: [
          { itemId: record.items[0]!.id, choice: 'A' },
          { itemId: record.items[1]!.id, choices: ['z'] },
        ],
      }),
    ).rejects.toThrow(/第 2 题：选项不在候选中 z/)
  }, 20000)

  it('ask_user 工具：questions 数组 → 一条待答 + suspend + 回执列出题号', async () => {
    const { pid, dev } = await setup()
    const res = await executeTool(
      'ask_user',
      {
        questions: [
          { question: '目标平台？', kind: 'single', options: ['Web', '桌面'] },
          { question: '要不要音效？', kind: 'confirm' },
        ],
      },
      await env(pid, dev.instanceId),
    )
    expect(res.ok).toBe(true)
    expect(res.ok && 'suspend' in res ? res.suspend : false).toBe(true)
    const summary = res.ok ? res.summary : ''
    expect(summary).toContain('2 个问题')
    expect(summary).toContain('1) 目标平台？')
    expect(summary).toContain('2) 要不要音效？')
    const pending = await svc.questions.list(pid, { status: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.items).toHaveLength(2)
  }, 20000)

  it('HTTP：{answers:[...]} 一次提交；答复以多行写回会话', async () => {
    const { pid, dev } = await setup()
    const { record } = await svc.questions.ask({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      asker: dev.instanceId,
      questions: [
        { question: 'A 还是 B？', kind: 'single', options: ['A', 'B'] },
        { question: '备注？', kind: 'text' },
      ],
    })
    const res = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/questions/${record.id}/answer`,
      payload: {
        answers: [
          { itemId: record.items[0]!.id, choice: 'B' },
          { itemId: record.items[1]!.id, text: '先跑 MVP' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().nextQuestion).toBeNull()
    const log = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const msg = (log.json().events as Array<{ role?: string; content?: { text?: string } }>).find(
      (e) => e.role === 'user' && String(e.content?.text ?? '').includes('【回答提问'),
    )
    expect(String(msg?.content?.text)).toContain('共 2 个问题')
    expect(String(msg?.content?.text)).toContain('→ B')
    expect(String(msg?.content?.text)).toContain('→ 先跑 MVP')
  }, 20000)

  it('超过 6 题被拒；单题简写仍可用（兼容）', async () => {
    const { pid, dev } = await setup()
    const tooMany = await executeTool(
      'ask_user',
      { questions: Array.from({ length: 7 }, (_, i) => ({ question: `第 ${i + 1} 问？` })) },
      await env(pid, dev.instanceId),
    )
    expect(tooMany.ok).toBe(false)
    expect(tooMany.ok ? '' : tooMany.reason).toContain('最多问 6 个问题')

    const single = await executeTool(
      'ask_user',
      { question: '按基线开工？', kind: 'confirm' },
      await env(pid, dev.instanceId),
    )
    expect(single.ok).toBe(true)
    const pending = await svc.questions.list(pid, { status: 'pending' })
    expect(pending[0]!.items).toHaveLength(1)
  }, 20000)

  it('旧数据兼容：没有 items 的旧记录读出来自动包装成 1 题', async () => {
    const { pid, dev } = await setup()
    // 直接写入一条"旧格式"记录
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        join(base, 'data', 'projects', pid, 'questions.jsonl'),
        JSON.stringify({
          id: 'q_legacy',
          projectId: pid,
          sessionId: `u_${dev.instanceId}`,
          asker: dev.instanceId,
          question: '旧格式问题？',
          kind: 'confirm',
          options: ['确认', '取消'],
          allowText: false,
          status: 'pending',
          answer: null,
          createdAt: new Date().toISOString(),
          answeredAt: null,
        }) + '\n',
        'utf8',
      ),
    )
    const list = await svc.questions.list(pid, { status: 'pending' })
    expect(list[0]!.items).toHaveLength(1)
    expect(list[0]!.items[0]!.question).toBe('旧格式问题？')
  }, 20000)

  it('模型一轮里问多件事：一次 ask_user 调用（questions 数组）即挂起，不并发多次', async () => {
    const { pid, dev } = await setup()
    let calls = 0
    const gateway = {
      async *streamChat() {
        calls++
        yield { content: '开工前有三件事要你拍板。' }
        yield { toolCall: { index: 0, id: 'q1', name: 'ask_user' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({
              questions: [
                { question: '目标平台？', kind: 'single', options: ['Web', '桌面'] },
                { question: '功能范围？', kind: 'multi', options: ['难度', '音效'] },
                { question: '技术栈？', kind: 'text' },
              ],
            }),
          },
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () =>
          listToolDefs()
            .filter((d) => d.name === 'ask_user')
            .map((d) => ({
              name: d.name,
              description: d.description,
              parameters: d.paramsSchema ?? { type: 'object', properties: {} },
            })) as ToolSchema[],
        exec: async (ctx, _st, name, args) => executeTool(name, args, await env(pid, ctx.member.instanceId)),
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'qlist',
    })
    expect(calls).toBe(1) // 一次调用即挂起
    const pending = await svc.questions.list(pid, { status: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.items).toHaveLength(3)
  }, 30000)
})
