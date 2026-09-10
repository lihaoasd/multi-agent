/**
 * 工具注册表 + 执行器（tools.md §2/§5 校验链的 MVP 实现）。
 * 校验链：已注册 → 会话类型可用 → 策略/审批判定 → 路径边界 → 执行。
 * 失败结构化返回 { ok:false, code, reason }；approval 命中返回 APPROVAL_REQUIRED+approvalId。
 */
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { AppError, ErrorCodes } from '../../shared/errors.js'
import { resolveVirtual, type PathRoots } from '../../domain/rules/path-resolver.js'
import { assessCommand, type PolicyVerdict } from '../../domain/rules/command-policy.js'

export type ToolResult =
  | { ok: true; summary: string }
  | { ok: false; code: string; reason: string; ruleId?: string; approvalId?: string }

export interface ToolDef {
  name: string
  description: string
  scope: 'workspace' | 'workdir' | 'readonly-global' | 'platform'
  /** 会话可用性：user|meeting（数组） */
  availableIn: string[]
  idempotent: boolean
  /** function-calling 参数 schema（JSON Schema；缺省视为无参对象） */
  paramsSchema?: Record<string, unknown>
}

export type ToolHandler = (args: Record<string, unknown>, env: ToolEnv) => Promise<ToolResult>

export interface ToolEnv {
  roots: PathRoots
  instanceId: string
  sessionType: 'user' | 'meeting'
  projectId: string
  approvalPolicy: { highRiskCommands: boolean }
  offline: boolean
  /** 当前激活任务 id（dispatcher 注入）：workdir_edit 等按任务聚合归属 */
  taskId?: string
  /** 用户已批准该次调用时置 true（approval 桥续跑） */
  approvalBypass?: boolean
}

const registry = new Map<string, ToolDef & { run: ToolHandler }>()

export function registerTool(def: ToolDef, run: ToolHandler): void {
  registry.set(def.name, { ...def, run })
}

export function listToolDefs(): Array<ToolDef & { availableIn: string[] }> {
  return [...registry.values()].map(({ run: _run, ...def }) => def)
}

export function isRegistered(name: string): boolean {
  return registry.has(name)
}

/** 执行工具（调用方负责会话/角色白名单）。 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<ToolResult> {
  const def = registry.get(name)
  if (!def) return { ok: false, code: 'ERR_TOOL_REJECTED', reason: `工具未注册: ${name}` }
  if (!def.availableIn.includes(env.sessionType)) {
    return {
      ok: false,
      code: 'ERR_TOOL_REJECTED',
      reason: `工具 ${name} 在 ${env.sessionType} 会话不可用`,
    }
  }
  try {
    return await def.run(args, env)
  } catch (err) {
    if (err instanceof AppError) return { ok: false, code: err.code, reason: err.message }
    return { ok: false, code: ErrorCodes.INTERNAL, reason: String(err) }
  }
}

// ---------- 内置工具（M3 MVP） ----------

registerTool(
  {
    name: 'fs_read_file',
    description: '读 workdir/ro:// 内文本文件（不含私有区）',
    scope: 'readonly-global',
    availableIn: ['user', 'meeting'],
    idempotent: true,
    paramsSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '虚拟路径，如 workdir://src/a.ts' } },
      required: ['path'],
    },
  },
  async (args, env) => {
    const p = String(args.path ?? '')
    const r = resolveVirtual(p, env.roots)
    if (r.scheme !== 'workdir' && r.scheme !== 'ro') {
      return { ok: false, code: 'FS_BOUNDARY', reason: 'fs_read_file 仅限 workdir:// 与 ro://' }
    }
    const max = 200_000
    const buf = await readFile(r.absolute, 'utf8').catch((e) => {
      throw e.code === 'ENOENT' ? new AppError(ErrorCodes.NOT_FOUND, `文件不存在: ${p}`) : e
    })
    const text = buf.length > max ? buf.slice(0, max) + '\n…(已截断)' : buf
    return { ok: true, summary: text }
  },
)

registerTool(
  {
    name: 'fs_list_dir',
    description: '列目录（workdir:// 与 ro://）',
    scope: 'readonly-global',
    availableIn: ['user', 'meeting'],
    idempotent: true,
    paramsSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '虚拟路径，缺省 workdir://' } },
    },
  },
  async (args, env) => {
    const p = String(args.path ?? 'workdir://')
    const r = resolveVirtual(p, env.roots)
    if (r.scheme !== 'workdir' && r.scheme !== 'ro') {
      return { ok: false, code: 'FS_BOUNDARY', reason: 'fs_list_dir 仅限 workdir:// 与 ro://' }
    }
    const names = await readdir(r.absolute).catch((e) =>
      e.code === 'ENOENT' ? [] : Promise.reject(e),
    )
    return { ok: true, summary: names.join('\n') || '(空目录)' }
  },
)

registerTool(
  {
    name: 'ws_write',
    description: '写私有工作区文件（新建/覆盖/追加/删除），仅 user 会话',
    scope: 'workspace',
    availableIn: ['user'],
    idempotent: false,
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '私有区路径，如 ws://notes/a.md' },
        action: { type: 'string', enum: ['write', 'append', 'delete'], description: '缺省 write' },
        content: { type: 'string', description: '写入内容' },
      },
      required: ['path'],
    },
  },
  async (args, env) => {
    const r = resolveVirtual(String(args.path ?? ''), env.roots)
    if (r.scheme !== 'ws')
      return { ok: false, code: 'FS_BOUNDARY', reason: 'ws_write 仅限本人私有区 ws://' }
    const action = String(args.action ?? 'write')
    const content = args.content === undefined ? '' : String(args.content)
    if (action === 'delete') {
      await rm(r.absolute, { force: true })
      return { ok: true, summary: `已删除 ${r.rel}` }
    }
    await mkdir(dirname(r.absolute), { recursive: true })
    await writeFile(
      r.absolute,
      action === 'append'
        ? content + (await readFile(r.absolute, 'utf8').catch(() => ''))
        : content,
      'utf8',
    )
    return {
      ok: true,
      summary: `已${action === 'append' ? '追加' : '写入'} ${r.rel} (${content.length} 字符)`,
    }
  },
)

registerTool(
  {
    name: 'ws_read',
    description: '读本人私有工作区文件',
    scope: 'workspace',
    availableIn: ['user', 'meeting'],
    idempotent: true,
    paramsSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '私有区路径，如 ws://notes/a.md' } },
      required: ['path'],
    },
  },
  async (args, env) => {
    const r = resolveVirtual(String(args.path ?? ''), env.roots)
    if (r.scheme !== 'ws')
      return { ok: false, code: 'FS_BOUNDARY', reason: 'ws_read 仅限本人私有区 ws://' }
    const buf = await readFile(r.absolute, 'utf8').catch((e) =>
      e.code === 'ENOENT' ? '' : Promise.reject(e),
    )
    return { ok: true, summary: buf.slice(0, 12000) || '(空文件)' }
  },
)

/** 命令运行器：测试注入 fake，生产走 child_process。 */
export type CommandRunner = (req: {
  program: string
  args: string[]
  cwd: string
  timeoutMs: number
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>

registerTool(
  {
    name: 'cmd_run',
    description: '在 workdir 内运行命令（结构化 argv，cwd 恒 workdir）',
    scope: 'workdir',
    availableIn: ['user'],
    idempotent: false,
    paramsSchema: {
      type: 'object',
      properties: {
        program: { type: 'string', description: '可执行程序，如 node/npm/git' },
        args: { type: 'array', items: { type: 'string' }, description: 'argv 数组' },
        cwd: { type: 'string', description: 'workdir:// 内子目录，缺省 workdir://' },
      },
      required: ['program'],
    },
  },
  async (args, env) => {
    const program = String(args.program ?? '')
    const argv = Array.isArray(args.args) ? args.args.map(String) : []
    if (!program) return { ok: false, code: 'ERR_VALIDATION', reason: 'program 必填' }
    // cwd 恒 workdir 根（可子目录，须在 workdir 内）
    const cwdArg = String(args.cwd ?? 'workdir://')
    const cwdRes = resolveVirtual(cwdArg, env.roots)
    if (cwdRes.scheme !== 'workdir') {
      return { ok: false, code: 'FS_BOUNDARY', reason: 'cmd_run cwd 必须在 workdir:// 内' }
    }
    const verdict: PolicyVerdict = assessCommand({ program, args: argv, offline: env.offline })
    if (verdict.decision === 'deny') {
      return { ok: false, code: 'CMD_FORBIDDEN', reason: `命令被禁: ${verdict.reason}` }
    }
    if (verdict.decision === 'approval') {
      // 审批由上层产生；批准后经 approvalBypass 续跑（agent-runtime §7）
      if (!env.approvalBypass) {
        return {
          ok: false,
          code: 'CMD_APPROVAL_REQUIRED',
          reason: `高危命令需审批: ${verdict.reason}`,
          ruleId: verdict.ruleId,
        }
      }
      return executeCommand({ program, args: argv, cwd: cwdRes.absolute })
    }
    return executeCommand({ program, args: argv, cwd: cwdRes.absolute })
  },
)

async function executeCommand(req: {
  program: string
  args: string[]
  cwd: string
  timeoutMs?: number
}): Promise<ToolResult> {
  const runner = getCommandRunner()
  const r = await runner({
    program: req.program,
    args: req.args,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs ?? 60_000,
  })
  const tail = (s: string) => (s.length > 8000 ? s.slice(-8000) + '\n…(已截断，保留尾部)' : s)
  if (r.exitCode !== 0) {
    return {
      ok: false,
      code: 'ERR_INTERNAL',
      reason: `命令退出码 ${r.exitCode}\n${tail(r.stderr || r.stdout)}`,
    }
  }
  return { ok: true, summary: tail(r.stdout || '(无输出)') }
}

let runnerOverride: CommandRunner | null = null

export function setCommandRunner(r: CommandRunner): void {
  runnerOverride = r
}

function getCommandRunner(): CommandRunner {
  if (runnerOverride) return runnerOverride
  return defaultCommandRunner
}

/** 默认 runner：spawn(program,args) shell=false。 */
async function defaultCommandRunner(req: {
  program: string
  args: string[]
  cwd: string
  timeoutMs: number
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(req.program, req.args, {
      cwd: req.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ exitCode: 124, stdout, stderr: stderr + '\n(命令超时)' })
    }, req.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

export { join }
