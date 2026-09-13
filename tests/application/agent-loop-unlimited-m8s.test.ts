/**
 * Agent loop 轮数（M8S，2026-09-12）：**默认无限轮**（模型不再调用工具即结束）。
 * 安全阀 = 无进展保护：同一「工具+入参+结果」连续 3 次 → 判定原地空转，停止并收尾。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import {
  AgentLoopRunner,
  type ToolRuntimeHook,
} from '../../src/application/agent-loop/loop-runner.js'
import { executeTool, listToolDefs } from '../../src/infra/tools/executor.js'
import type { ToolSchema } from '../../src/infra/model/provider.js'
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
  base = await makeTempDir('unlimited-')
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
    payload: { name: 'unlimited', workdir, team: [{ roleTemplateId: 'dev' }] },
  })
  const p = res.json().project
  return { pid: p.id, dev: (p.team as TeamMemberConfig[])[0]! }
}

/** 工具运行时：**不设 maxSteps**（= 无限轮，用默认值）。 */
function runtime(pid: string, tools: ToolSchema[]): ToolRuntimeHook {
  return {
    listTools: () => tools,
    exec: async (ctx, _st, name, args) =>
      executeTool(
        name,
        args,
        await (await import('../../src/application/composition.js')).buildToolEnv(
          { config, projectService: svc.projectService },
          pid,
          ctx.member.instanceId,
          { sessionId: ctx.sessionId },
        ),
      ),
  }
}

const defs = (names: string[]): ToolSchema[] =>
  listToolDefs()
    .filter((d) => names.includes(d.name))
    .map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.paramsSchema ?? { type: 'object', properties: {} },
    }))

describe('Agent loop 轮数：默认无限', () => {
  it('连续 15 轮工具调用（远超旧的 10 步上限）→ 正常跑完并给出结论', async () => {
    const { pid, dev } = await setup()
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        if (call <= 15) {
          // 每轮参数不同（避免被判空转）
          yield { toolCall: { index: 0, id: `c${call}`, name: 'workdir_edit' } }
          yield {
            toolCall: {
              index: 0,
              argumentsDelta: JSON.stringify({
                path: `workdir://notes/n${call}.md`,
                edits: [{ type: 'write', text: `第 ${call} 份笔记\n` }],
              }),
            },
          }
          return
        }
        yield { content: `全部完成，共写了 ${call - 1} 份笔记。` }
      },
    } as unknown as ModelGateway

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: runtime(pid, defs(['workdir_edit'])),
    })
    const evt = await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'unlimited',
    })
    expect(call).toBe(16) // 15 轮工具 + 1 轮收尾正文
    expect(evt.content?.text ?? '').toContain('全部完成，共写了 15 份笔记')
  }, 30000)

  it('原地空转（同工具+同入参+同结果连续 3 次）→ 平台停止并写明原因', async () => {
    const { pid, dev } = await setup()
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        // 永远调用同一个只读工具、同样参数 → 结果永远一样
        yield { toolCall: { index: 0, id: `c${call}`, name: 'fs_list_dir' } }
        yield { toolCall: { index: 0, argumentsDelta: JSON.stringify({ path: 'workdir://' }) } }
      },
    } as unknown as ModelGateway

    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: runtime(pid, defs(['fs_list_dir'])),
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'stall',
    })

    // 3 次相同调用后停止：3 轮主循环 + 1 轮收尾（收尾回合再调一次，然后循环结束）
    expect(call).toBeLessThanOrEqual(6)
    const res = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/sessions/u_${dev.instanceId}/log`,
    })
    const evts = res.json().events as Array<{ payload?: Record<string, unknown>; content?: { text?: string } }>
    const note = evts.find((e) => String(e.content?.text ?? '').includes('原地空转'))
    expect(note).toBeTruthy()
    expect(String(note!.content?.text)).toContain('已停止')
  }, 30000)

  it('显式 maxSteps 仍可作硬上限（特殊场景/测试用）', async () => {
    const { pid, dev } = await setup()
    let call = 0
    const gateway = {
      async *streamChat() {
        call++
        yield { toolCall: { index: 0, id: `c${call}`, name: 'workdir_edit' } }
        yield {
          toolCall: {
            index: 0,
            argumentsDelta: JSON.stringify({
              path: `workdir://notes/m${call}.md`,
              edits: [{ type: 'write', text: `x${call}\n` }],
            }),
          },
        }
      },
    } as unknown as ModelGateway
    const loop = new AgentLoopRunner({
      store: svc.sessionStore,
      gateway,
      bus: svc.bus,
      toolRuntime: { ...runtime(pid, defs(['workdir_edit'])), maxSteps: 2 },
    })
    await loop.runDirectTurn({
      projectId: pid,
      sessionId: `u_${dev.instanceId}`,
      member: dev,
      scenario: 'capped',
    })
    // 2 步主循环 + 1 步收尾
    expect(call).toBe(3)
  }, 30000)
})
