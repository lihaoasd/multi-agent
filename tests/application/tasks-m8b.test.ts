import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { composeServices } from '../../src/application/composition.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/shared/config.js'
import { executeTool } from '../../src/infra/tools/executor.js'
import type { ToolEnv } from '../../src/infra/tools/executor.js'
import { makeTempDir } from '../helpers.js'

const BUILTIN_DIR = join(process.cwd(), 'src', 'shared', 'roles')

let base: string
let workdir: string
let app: FastifyInstance | null = null
let svc: ReturnType<typeof composeServices>

beforeEach(async () => {
  base = await makeTempDir('tasks-')
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

async function setupProject(): Promise<{ pid: string; dev: string; pm: string }> {
  const res = await ready().inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'tk', workdir, team: [{ roleTemplateId: 'dev' }, { roleTemplateId: 'pm' }] },
  })
  const p = res.json().project
  const dev = p.team.find((t: { instanceId: string }) => t.instanceId === 'dev_1').instanceId
  const pm = p.team.find((t: { instanceId: string }) => t.instanceId === 'pm_1').instanceId
  return { pid: p.id, dev, pm }
}

describe('任务系统（乙模式 + D17-①）', () => {
  it('创建 todo → 置 in_progress（唤醒触发 Agent 回合）→ done', async () => {
    const { pid, dev } = await setupProject()
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: '实现登录模块', assignee: dev, creator: 'user' },
    })
    expect(created.statusCode).toBe(201)
    const tid = created.json().task.id
    expect(created.json().task.state).toBe('todo')

    const act = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'in_progress', actor: 'user' },
    })
    expect(act.statusCode).toBe(200)
    expect(act.json().task.state).toBe('in_progress')

    // 置 in_progress = 唤醒：受派者 user 会话出现系统提示且 Agent 完成一轮（turn_end）
    const sid = `u_${dev}`
    const deadline = Date.now() + 8000
    for (;;) {
      const log = await ready().inject({
        method: 'GET',
        url: `/api/projects/${pid}/sessions/${sid}/log`,
      })
      const evts = log.json().events
      const hasWake = evts.some(
        (e: { kind: string; role?: string; content?: { text?: string } }) =>
          e.kind === 'message' &&
          e.role === 'user' &&
          String(e.content?.text ?? '').includes('任务栏有任务待你领取'),
      )
      if (hasWake && evts.some((e: { kind: string }) => e.kind === 'turn_end')) break
      if (Date.now() > deadline) throw new Error('等待唤醒回合超时')
      await new Promise((r) => setTimeout(r, 30))
    }

    const done = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'done', actor: 'user' },
    })
    expect(done.json().task.state).toBe('done')
  })

  it('每 Agent 至多 1 in_progress：第二个任务保持待领取；完成后平台通知领取下一条', async () => {
    const { pid, dev } = await setupProject()
    const mk = (title: string) =>
      ready().inject({
        method: 'POST',
        url: `/api/projects/${pid}/tasks`,
        payload: { title, assignee: dev, creator: 'user' },
      })
    const t1 = (await mk('任务A')).json().task
    const t2 = (await mk('任务B')).json().task
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${t1.id}`,
      payload: { state: 'in_progress' },
    })
    // 槽位被占：领取 t2 被拒（ERR_CONFLICT），且 status 字段走服务层校验
    await expect(svc.tasks.claim(pid, dev, t2.id)).rejects.toThrow(/已有进行中任务/)
    // t1 完成 → 平台**只通知**，不再自动开工（发布-领取制）
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${t1.id}`,
      payload: { state: 'done' },
    })
    const list = await ready().inject({ method: 'GET', url: `/api/projects/${pid}/tasks` })
    const t2After = (list.json().tasks as Array<{ id: string; state: string }>).find(
      (x) => x.id === t2.id,
    )
    expect(t2After!.state).toBe('todo') // 仍待领取，等受派人 claim
    // 受派人自己领取 → in_progress
    const claimed = await svc.tasks.claim(pid, dev)
    expect(claimed.id).toBe(t2.id)
    expect(claimed.state).toBe('in_progress')
  })

  it('terminated 仅用户可置、终态不可回退；done 非 user 被拒', async () => {
    const { pid, dev, pm } = await setupProject()
    const created = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: 'x', assignee: dev },
    })
    const tid = created.json().task.id
    await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'in_progress' },
    })
    // Agent 不能替用户确认 done
    const agentDone = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'done', actor: pm },
    })
    expect(agentDone.statusCode).toBe(409)
    // user 终止
    const term = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'terminated', actor: 'user' },
    })
    expect(term.json().task.state).toBe('terminated')
    // 终态再置位被拒
    const back = await ready().inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/tasks/${tid}`,
      payload: { state: 'todo' },
    })
    expect(back.statusCode).toBe(409)
  })

  it('乙模式：Agent 创建任务被拒（assignByAgent=false）', async () => {
    const { pid, dev, pm } = await setupProject()
    const res = await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: 'x', assignee: dev, creator: pm },
    })
    expect(res.statusCode).toBe(409)
  })

  it('tasks 列表按 assignee/state 过滤', async () => {
    const { pid, dev } = await setupProject()
    await ready().inject({
      method: 'POST',
      url: `/api/projects/${pid}/tasks`,
      payload: { title: 'A', assignee: dev },
    })
    const list = await ready().inject({
      method: 'GET',
      url: `/api/projects/${pid}/tasks?assignee=${dev}`,
    })
    expect(list.json().tasks).toHaveLength(1)
  })
})

describe('记忆/检索工具（应用级注册）', () => {
  function toolEnv(): ToolEnv {
    return {
      roots: {
        wsRoot: join(base, 'data', 'projects', 'p_x', 'workspaces', 'dev_1'),
        workdirRoot: workdir,
        roRoots: [],
        runtimeRoot: join(base, 'data', 'projects', 'p_x'),
      },
      instanceId: 'dev_1',
      sessionType: 'user',
      projectId: 'p_x',
      approvalPolicy: { highRiskCommands: true },
      offline: false,
    }
  }

  it('memory_append 写入个人记忆（pm 可写全局，dev 全局被拒）', async () => {
    const env = toolEnv()
    const own = await executeTool(
      'memory_append',
      { content: '用户偏好中文注释', type: 'preference' },
      env,
    )
    expect(own.ok).toBe(true)
    const globalDev = await executeTool('memory_append', { content: '全局x', scope: 'global' }, env)
    expect(globalDev.ok).toBe(false) // 非 pm 不可写全局
    const pmEnv: ToolEnv = { ...env, instanceId: 'pm_1' }
    const globalPm = await executeTool(
      'memory_append',
      { content: '决策：方案A', scope: 'global' },
      pmEnv,
    )
    expect(globalPm.ok).toBe(true)
  })

  it('memory_search / session_search 已注册并返回 ok（空库返回无命中提示）', async () => {
    const env = toolEnv()
    const ms = await executeTool('memory_search', { q: '中文' }, env)
    expect(ms.ok).toBe(true)
    const ss = await executeTool('session_search', { q: '登录' }, env)
    expect(ss.ok).toBe(true)
  })
})
