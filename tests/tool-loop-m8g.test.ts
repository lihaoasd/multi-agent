import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices, buildToolEnv } from '../src/application/composition.js'
import { buildApp } from '../src/server/app.js'
import { loadConfig } from '../src/shared/config.js'
import {
  AgentLoopRunner,
  type ActiveTask,
  type ToolRuntimeHook,
  type TurnContext,
} from '../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../src/infra/tools/executor.js'
import type { ChatMessage, ChatStreamItem, ToolSchema } from '../src/infra/model/provider.js'
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
  base = await makeTempDir('tool-loop-')
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
    payload: { name: 'tl', workdir, team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'product' }] },
  })
  const p = res.json().project
  const dev = (p.team as TeamMemberConfig[]).find((t) => t.roleTemplateId === 'dev')!
  return { pid: p.id, dev }
}

/** 按调用次序产出脚本化流的假网关；记录每次调用的 messages。 */
function scriptedGateway(
  steps: ChatStreamItem[][],
  calls: ChatMessage[][],
): ModelGateway {
  let i = 0
  return {
    async *streamChat(opts: { messages: ChatMessage[] }) {
      calls.push(opts.messages)
      const step = steps[Math.min(i, steps.length - 1)] ?? []
      i++
      for (const item of step) yield item
    },
  } as unknown as ModelGateway
}

/** 真实注册表派生的工具运行时（白名单 ∩ availableIn）。 */
function realToolRuntime(activeTask?: () => Promise<ActiveTask | null>): ToolRuntimeHook {
  return {
    listTools: (ctx, sessionType) => {
      const allowed = new Set(ctx.member.tools ?? [])
      return listToolDefs()
        .filter((d) => allowed.has(d.name) && d.availableIn.includes(sessionType))
        .map(
          (d): ToolSchema => ({
            name: d.name,
            description: d.description,
            parameters: d.paramsSchema ?? { type: 'object', properties: {} },
          }),
        )
    },
    exec: async (ctx, sessionType, name, args) =>
      executeTool(
        name,
        args,
        await buildToolEnv({ config, projectService: svc.projectService }, ctx.projectId, ctx.member.instanceId, {
          taskId: (await activeTask?.())?.id,
          sessionType: sessionType === 'meeting' ? 'meeting' : 'user',
        }),
      ),
    activeTask,
    maxSteps: 4,
  }
}

function turnCtx(pid: string, dev: TeamMemberConfig): TurnContext {
  return { projectId: pid, sessionId: `u_${dev.instanceId}`, member: dev, scenario: 'tool-loop' }
}

describe('Agent 工具循环（function-calling）', () => {
  it('模型请求 fs_read_file → 执行并回注 tool 消息 → 第二轮据结果作答', async () => {
    const { pid, dev } = await setupProject()
    await writeFile(join(workdir, 'hello.txt'), 'hello-agent\n', 'utf8')

    const calls: ChatMessage[][] = []
    const gateway = scriptedGateway(
      [
        [
          { reasoning: '先读文件再回答。' },
          { toolCall: { index: 0, id: 'call_1', name: 'fs_read_file' } },
          { toolCall: { index: 0, argumentsDelta: '{"path":"workdir://hel' } },
          { toolCall: { index: 0, argumentsDelta: 'lo.txt"}' } },
        ],
        [{ content: '文件内容为：hello-agent' }],
      ],
      calls,
    )
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: realToolRuntime(),
    })
    const evt = await loop.runDirectTurn(turnCtx(pid, dev))

    // 工具结果已回注（role=tool）
    const secondCall = calls[1] ?? []
    const toolMsg = secondCall.find((m) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(toolMsg!.content).toContain('hello-agent')
    // assistant 带 tool_calls 的历史也在
    expect(secondCall.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(true)

    // 审计事件 + 最终回复
    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log` })
    ).json().events as Array<{ kind: string; payload?: Record<string, unknown> }>
    const call = evts.find((e) => e.kind === 'tool_call')
    expect(call?.payload?.tool).toBe('fs_read_file')
    const result = evts.find((e) => e.kind === 'tool_result')
    expect(result?.payload?.ok).toBe(true)
    expect(String(result?.payload?.summary ?? '')).toContain('hello-agent')
    expect(evt.content?.text).toContain('文件内容为：hello-agent')
  })

  it('workdir_edit 归属注入的当前任务（env.taskId 优先）并留 code-edits 轨迹', async () => {
    const { pid, dev } = await setupProject()
    const activeTask = async (): Promise<ActiveTask> => ({
      id: 't_demo',
      title: '写一个文件',
      desc: '验证任务级聚合',
    })
    const gateway = scriptedGateway(
      [
        [
          {
            toolCall: {
              index: 0,
              id: 'call_w',
              name: 'workdir_edit',
              argumentsDelta: JSON.stringify({
                path: 'workdir://src/out.txt',
                edits: [{ type: 'write', text: 'console.log(1)\n' }],
                taskId: 'spoofed_should_be_ignored',
              }),
            },
          },
        ],
        [{ content: '已写入 src/out.txt' }],
      ],
      [],
    )
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: realToolRuntime(activeTask),
    })
    await loop.runDirectTurn(turnCtx(pid, dev))

    expect(await readFile(join(workdir, 'src', 'out.txt'), 'utf8')).toBe('console.log(1)\n')
    const agg = await readFile(
      join(config.dataDir, 'projects', pid, 'code-edits', 't_demo.jsonl'),
      'utf8',
    )
    expect(agg).toContain('src/out.txt')
    // 任务归属来自注入，而非模型自报
    await expect(
      readFile(join(config.dataDir, 'projects', pid, 'code-edits', 'spoofed_should_be_ignored.jsonl'), 'utf8'),
    ).rejects.toThrow()
    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log` })
    ).json().events as Array<{ kind: string; payload?: Record<string, unknown> }>
    const result = evts.find((e) => e.kind === 'tool_result')
    expect(String(result?.payload?.summary ?? '')).toContain('t_demo')
  })

  it('高危命令 → 生成审批记录并把"待批准"回注模型', async () => {
    const { pid, dev } = await setupProject()
    const gateway = scriptedGateway(
      [
        [
          {
            toolCall: {
              index: 0,
              id: 'call_cmd',
              name: 'cmd_run',
              argumentsDelta: JSON.stringify({ program: 'git', args: ['push'] }),
            },
          },
        ],
        [{ content: '推送需要你批准，我已提交审批。' }],
      ],
      [],
    )
    const tools = realToolRuntime()
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: {
        ...tools,
        requestApproval: async (ctx, name, args) => {
          if (name !== 'cmd_run') return null
          const argv = Array.isArray(args.args) ? args.args.map(String) : []
          const rec = await svc.tools.requestCommand({
            projectId: ctx.projectId,
            actor: ctx.member.instanceId,
            sessionId: ctx.sessionId,
            summary: `执行命令：${String(args.program)} ${argv.join(' ')}`,
            command: { program: String(args.program), args: argv, cwd: 'workdir://' },
          })
          return rec.id
        },
      },
    })
    await loop.runDirectTurn(turnCtx(pid, dev))

    const pending = await svc.approvals.list(pid, 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('command')
    expect(pending[0]!.summary).toContain('git push')

    const evts = (
      await ready().inject({ method: 'GET', url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log` })
    ).json().events as Array<{ kind: string; payload?: Record<string, unknown> }>
    const result = evts.find((e) => e.kind === 'tool_result')
    expect(result?.payload?.code).toBe('APPROVAL_PENDING')
    expect(String(result?.payload?.reason ?? '')).toContain(pending[0]!.id)
  })
})
