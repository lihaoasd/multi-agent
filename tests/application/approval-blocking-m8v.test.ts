/**
 * 阻塞式审批（M8V，2026-09-12）：需要审批的命令不再"边等边干"。
 *
 * 用户反馈："审批也是没有阻塞，角色继续执行"。
 * 旧行为：审批提交后工具返回"请向用户说明并继续其余工作" → 角色继续干活，
 * 用户批准后角色也不知道结果（结果没回注）。
 *
 * 新行为：
 *  1) 需要审批 → 工具结果 `APPROVAL_PENDING` → loop **立即结束本回合**（角色进入「等待你处理」）；
 *  2) 用户批准 → 平台执行原命令，把**执行结果**写回会话并唤醒角色继续；
 *  3) 用户拒绝 → 同样唤醒，告诉它不要再申请/不要绕过。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { AgentLoopRunner } from '../../src/application/agent-loop/loop-runner.js'
import { setCommandRunner } from '../../src/infra/tools/executor.js'
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
  base = await makeTempDir('approval-')
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
    payload: { name: 'approval', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

const env = (pid: string, iid: string) =>
  buildToolEnv({ config, projectService: svc.projectService }, pid, iid, { sessionId: `u_${iid}` })

/** 一个"需要审批"的命令：rm -rf（高危清单命中）。 */
const RISKY = { program: 'rm', args: ['-rf', 'node_modules'] }

describe('阻塞式审批：提交后停下，决定后带着结果继续', () => {
  it('需要审批的命令 → 本回合立即结束（模型只调一次、不再继续执行）', async () => {
    const { pid, dev } = await setup()
    let calls = 0
    const seen: ChatMessage[][] = []
    const gateway = {
      async *streamChat(opts: { messages: ChatMessage[] }) {
        seen.push(opts.messages)
        calls++
        // 第 1 轮就申请审批；若平台不阻塞，模型下一轮会继续干别的
        yield { toolCall: { index: 0, id: 'c1', name: 'cmd_run' } }
        yield { toolCall: { index: 0, argumentsDelta: JSON.stringify(RISKY) } }
        if (calls > 1) {
          yield { toolCall: { index: 1, id: 'c2', name: 'workdir_edit' } }
          yield {
            toolCall: {
              index: 1,
              argumentsDelta: JSON.stringify({
                path: 'workdir://notes/after-approval.md',
                edits: [{ type: 'write', text: '不该在等审批时写\n' }],
              }),
            },
          }
        }
      },
    } as unknown as ModelGateway

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      occupancy: svc.occupancy,
      toolRuntime: {
        listTools: () => [{ name: 'cmd_run' }, { name: 'workdir_edit' }] as unknown as ToolSchema[],
        exec: async (ctx, _st, name, args) => {
          const { executeTool } = await import('../../src/infra/tools/executor.js')
          return executeTool(name, args, await env(pid, ctx.member.instanceId))
        },
        requestApproval: async (ctx, name, args) => {
          if (name !== 'cmd_run') return null
          const rec = await svc.tools.requestCommand({
            projectId: ctx.projectId,
            actor: ctx.member.instanceId,
            sessionId: ctx.sessionId,
            summary: `执行命令：${String(args.program ?? '')}`,
            command: {
              program: String(args.program ?? ''),
              args: (args.args ?? []) as string[],
              cwd: 'workdir://',
            },
          })
          return rec.id
        },
        flushDeferred: async (ctx) => svc.questions.flushPending(ctx.projectId, ctx.sessionId),
      },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'approval-block',
    })

    expect(calls).toBe(1) // 阻塞：没有第二轮
    const fsMod = await import('node:fs/promises')
    expect(await fsMod.readdir(join(workdir, 'notes')).catch(() => [])).toEqual([]) // 没继续干活
    const pending = await svc.approvals.list(pid, 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('command')
    // 审计里带 approvalId（前端渲染成 ⏸ 等待审批，而不是 ✗ 失败）
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const row = (res.json().events as Array<{ kind: string; payload?: Record<string, unknown> }>).find(
      (e) => e.kind === 'tool_result' && e.payload?.tool === 'cmd_run',
    )
    expect(row!.payload?.code).toBe('APPROVAL_PENDING')
    expect(row!.payload?.approvalId).toBe(pending[0]!.id)
    expect(String(row!.payload?.reason)).toContain('本轮到此结束')
    // 团队状态：等待你处理（有待批审批）
    const agents = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    const me = (agents.json().agents as Array<{ instanceId: string; state: string }>).find(
      (a) => a.instanceId === dev.instanceId,
    )
    expect(me!.state).toBe('waiting')
  }, 30000)

  it('用户批准 → 平台执行命令 + 结果写回会话并唤醒角色继续', async () => {
    const { pid, dev } = await setup()
    setCommandRunner(async () => ({ exitCode: 0, stdout: 'removed 42 packages', stderr: '' }))
    const rec = await svc.tools.requestCommand({
      projectId: pid,
      actor: dev.instanceId,
      sessionId: `u_${dev.instanceId}`,
      summary: '执行命令：rm -rf node_modules',
      command: { program: 'rm', args: ['-rf', 'node_modules'], cwd: 'workdir://' },
    })
    const res = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/approvals/${rec.id}/decide`,
      payload: { decision: 'approved' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().approval.status).toBe('approved')
    expect(res.json().wakeError).toBeNull()

    const log = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const texts = (log.json().events as Array<{ content?: { text?: string } }>)
      .map((e) => String(e.content?.text ?? ''))
      .join('\n')
    expect(texts).toContain('已获批准')
    expect(texts).toContain('removed 42 packages') // 执行结果回注给角色
    expect(texts).toContain('请继续你的任务')
  }, 30000)

  it('用户拒绝 → 唤醒角色并告知被拒（不要再申请、不要绕过）', async () => {
    const { pid, dev } = await setup()
    const rec = await svc.tools.requestCommand({
      projectId: pid,
      actor: dev.instanceId,
      sessionId: `u_${dev.instanceId}`,
      summary: '执行命令：rm -rf node_modules',
      command: { program: 'rm', args: ['-rf', 'node_modules'], cwd: 'workdir://' },
    })
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/approvals/${rec.id}/decide`,
      payload: { decision: 'rejected', reason: '先别删，我要复现问题' },
    })
    const log = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const texts = (log.json().events as Array<{ content?: { text?: string } }>)
      .map((e) => String(e.content?.text ?? ''))
      .join('\n')
    expect(texts).toContain('已被用户拒绝')
    expect(texts).toContain('先别删，我要复现问题')
    expect(texts).toContain('不要重复申请')
  }, 30000)

  it('审批通过后团队状态从「等待你处理」回到空闲/继续', async () => {
    const { pid, dev } = await setup()
    setCommandRunner(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    const rec = await svc.tools.requestCommand({
      projectId: pid,
      actor: dev.instanceId,
      sessionId: `u_${dev.instanceId}`,
      summary: '执行命令：rm -rf node_modules',
      command: { program: 'rm', args: ['-rf', 'node_modules'], cwd: 'workdir://' },
    })
    const before = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    expect(
      (before.json().agents as Array<{ instanceId: string; state: string }>).find(
        (a) => a.instanceId === dev.instanceId,
      )!.state,
    ).toBe('waiting')
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/approvals/${rec.id}/decide`,
      payload: { decision: 'approved' },
    })
    const after = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/agents` })
    const state = (
      after.json().agents as Array<{ instanceId: string; state: string }>
    ).find((a) => a.instanceId === dev.instanceId)!.state
    expect(state).not.toBe('waiting') // 审批已决定 → 不再"等待你处理"
  }, 30000)
})
