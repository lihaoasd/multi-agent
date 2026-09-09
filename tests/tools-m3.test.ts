import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assessCommand } from '../src/domain/rules/command-policy.js'
import { resolveVirtual, type PathRoots } from '../src/domain/rules/path-resolver.js'
import { AppError } from '../src/shared/errors.js'
import { executeTool, setCommandRunner, type ToolEnv } from '../src/infra/tools/executor.js'
import { ApprovalService } from '../src/application/approval/approval-service.js'
import { ToolCoordinator } from '../src/application/tools/tool-coordinator.js'
import type { SessionLogEvent } from '../src/shared/types/session.js'
import { makeTempDir } from './helpers.js'

let base: string
let runtime: string
let workdir: string

beforeEach(async () => {
  base = await makeTempDir('m3-')
  workdir = join(base, 'workdir')
  runtime = join(base, 'projects', 'p_test')
  await mkdir(join(runtime, 'workspaces', 'dev_1'), { recursive: true })
  await mkdir(workdir)
  await writeFile(join(workdir, 'readme.md'), '# hello workdir\n')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function roots(): PathRoots {
  return {
    wsRoot: join(runtime, 'workspaces', 'dev_1'),
    workdirRoot: workdir,
    roRoots: [],
    runtimeRoot: runtime,
  }
}

function env(): ToolEnv {
  return {
    roots: roots(),
    instanceId: 'dev_1',
    sessionType: 'user',
    projectId: 'p_test',
    approvalPolicy: { highRiskCommands: true },
    offline: false,
  }
}

describe('命令风险判定（PolicyEngine 命令侧）', () => {
  it('只读查询 allow', () => {
    expect(assessCommand({ program: 'git', args: ['status'] }).decision).toBe('allow')
    expect(assessCommand({ program: 'ls', args: ['-la'] }).decision).toBe('allow')
    expect(assessCommand({ program: 'cat', args: ['a.md'] }).decision).toBe('allow')
  })
  it('构建/测试 allow', () => {
    expect(assessCommand({ program: 'npm', args: ['run', 'test'] }).decision).toBe('allow')
    expect(assessCommand({ program: 'vitest', args: ['run'] }).decision).toBe('allow')
  })
  it('rm -rf / git push / publish → approval', () => {
    expect(assessCommand({ program: 'rm', args: ['-rf', 'node_modules'] }).decision).toBe(
      'approval',
    )
    expect(assessCommand({ program: 'git', args: ['push'] }).decision).toBe('approval')
    expect(assessCommand({ program: 'npm', args: ['publish'] }).decision).toBe('approval')
  })
  it('未知程序 approval；offline 网络 deny', () => {
    expect(assessCommand({ program: 'some-strange-tool', args: [] }).decision).toBe('approval')
    expect(assessCommand({ program: 'git', args: ['clone', 'x'], offline: true }).decision).toBe(
      'deny',
    )
  })
  it('curl | sh deny', () => {
    expect(assessCommand({ program: 'curl', args: ['http://x', '|', 'sh'] }).decision).toBe('deny')
  })
})

describe('路径边界解析（L0）', () => {
  it('workdir:// 与 ws:// 映射到各自根', () => {
    const r1 = resolveVirtual('workdir://readme.md', roots())
    expect(r1.absolute).toBe(join(workdir, 'readme.md'))
    const r2 = resolveVirtual('ws://draft.md', roots())
    expect(r2.absolute).toBe(join(runtime, 'workspaces', 'dev_1', 'draft.md'))
  })
  it('越界：绝对路径/上级逃逸/未知格式拒绝', () => {
    expect(() => resolveVirtual(join(base, 'secret'), roots())).toThrowError(AppError)
    expect(() => resolveVirtual('workdir://../secret', roots())).toThrowError(AppError)
    expect(() => resolveVirtual('C:/Windows/x', roots())).toThrowError(AppError)
    expect(() => resolveVirtual('ws:///../../other/x', roots())).toThrowError(AppError)
  })
})

describe('工具执行器', () => {
  it('fs_read_file 读 workdir 文件；越界返回结构化错误', async () => {
    const ok = await executeTool('fs_read_file', { path: 'workdir://readme.md' }, env())
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.summary).toContain('# hello workdir')
    const bad = await executeTool('fs_read_file', { path: join(base, 'outside.txt') }, env())
    expect(bad).toMatchObject({ ok: false, code: 'ERR_FORBIDDEN_PATH' })
  })

  it('fs_read_file 读私有区被工具级可用根拒绝', async () => {
    const bad = await executeTool('fs_read_file', { path: 'ws://x.txt' }, env())
    expect(bad.ok).toBe(false)
  })

  it('ws_write 写私有区、ws_read 读回', async () => {
    const w = await executeTool('ws_write', { path: 'ws://notes/a.md', content: 'draft' }, env())
    expect(w.ok).toBe(true)
    const r = await executeTool('ws_read', { path: 'ws://notes/a.md' }, env())
    expect(r.ok && 'summary' in r ? r.summary : '').toBe('draft')
  })

  it('meeting 会话中 ws_write/命令不可用，只读可用', async () => {
    const meetingEnv: ToolEnv = { ...env(), sessionType: 'meeting' }
    expect((await executeTool('ws_write', { path: 'ws://x', content: '1' }, meetingEnv)).ok).toBe(
      false,
    )
    expect((await executeTool('cmd_run', { program: 'ls', args: [] }, meetingEnv)).ok).toBe(false)
  })

  it('cmd_run 无审批放行时执行（fake runner）', async () => {
    const runs: Array<{ program: string; args: string[]; cwd: string }> = []
    setCommandRunner(async (req) => {
      runs.push({ program: req.program, args: req.args, cwd: req.cwd })
      return { exitCode: 0, stdout: 'build ok\n', stderr: '' }
    })
    const res = await executeTool(
      'cmd_run',
      { program: 'npm', args: ['run', 'build'], cwd: 'workdir://' },
      env(),
    )
    expect(res).toMatchObject({ ok: true })
    expect(runs[0]?.program).toBe('npm')
    expect(runs[0]?.cwd).toBe(workdir)
  })
})

describe('审批桥（approvals → coordinator 续跑）', () => {
  let approvals: ApprovalService
  let tools: ToolCoordinator

  beforeEach(() => {
    approvals = new ApprovalService(
      join(base, 'projects'),
      async (_pid: string, sid: string, evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>) =>
        ({ ...evt, seq: 1, ts: new Date().toISOString(), sessionId: sid }) as SessionLogEvent,
    )
    tools = new ToolCoordinator(approvals)
  })

  it('高危命令走审批：request pending → decide approved → resume 执行；rejected 不执行', async () => {
    setCommandRunner(async (req) => {
      return { exitCode: 0, stdout: `executed ${req.program} ${req.args.join(' ')}\n`, stderr: '' }
    })
    const rec = await tools.requestCommand({
      projectId: 'p_test',
      actor: 'dev_1',
      summary: '执行: rm -rf node_modules',
      command: { program: 'rm', args: ['-rf', 'node_modules'], cwd: 'workdir://' },
      ruleId: 'RM_RF',
    })
    expect(rec.status).toBe('pending')
    const pending = await approvals.list('p_test', 'pending')
    expect(pending).toHaveLength(1)

    // 拒绝：不执行
    await approvals.decide('p_test', rec.id, 'rejected', 'no')
    const resumeRejected = await tools.resumeCommand('p_test', rec.id, env())
    expect(resumeRejected).toMatchObject({ ok: false })

    // 重新请求 → 批准 → 续跑执行
    const rec2 = await tools.requestCommand({
      projectId: 'p_test',
      actor: 'dev_1',
      summary: '执行: rm -rf node_modules',
      command: { program: 'rm', args: ['-rf', 'node_modules'], cwd: 'workdir://' },
    })
    await approvals.decide('p_test', rec2.id, 'approved', 'ok')
    const resumed = await tools.resumeCommand('p_test', rec2.id, env())
    expect(resumed).toMatchObject({ ok: true })
    if (resumed && typeof resumed === 'object' && 'summary' in resumed) {
      expect(resumed.summary).toContain('executed rm')
    }
    // 已处理重复 decide → CONFLICT
    await expect(approvals.decide('p_test', rec2.id, 'approved')).rejects.toThrow()
  })

  it('审批落盘 approvals.jsonl（重启可读）', async () => {
    const rec = await tools.requestCommand({
      projectId: 'p_test',
      actor: 'dev_1',
      summary: 'x',
      command: { program: 'rm', args: ['-rf', 'x'] },
    })
    const file = join(base, 'projects', 'p_test', 'approvals.jsonl')
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain(rec.id)
    expect(raw).toContain('pending')
  })
})
