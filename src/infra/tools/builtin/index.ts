import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PathResolver } from '../../../ports/path-resolver'
import type { CmdRunner } from '../../../ports/sandbox'
import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'
import { classifyCommand } from '../../../domain/rules/policy'
import { err, ok, type Result } from '../../../shared/result'

/** 内置工具（S4 范围：只读 fs 三件套 + cmd_run + approval_query） */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符）`
}

export interface BuiltinToolDeps {
  readonly paths: PathResolver
  readonly cmd: CmdRunner
}

const SESSION_USER_ONLY = ['user'] as const

export function fsReadFileTool(deps: BuiltinToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'fs_read_file',
      package: 'fs',
      description: '读取项目工作目录或只读平台资源中的文本文件（路径用 workdir:// 或 ro:// 前缀）',
      paramsSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '虚拟路径，如 workdir://src/index.ts' },
          maxChars: { type: 'number', description: '最多返回多少字符（默认 20000）' },
        },
        required: ['path'],
      },
      scope: 'workdir',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir', 'ro'],
      output: { maxChars: 20_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const path = record === undefined ? undefined : readString(record, 'path')
      if (path === undefined) return { ok: false, text: '缺少 path', errorCode: 'ERR_VALIDATION' }

      const resolved = deps.paths.resolve(path, context.roots)
      if (!resolved.ok) return { ok: false, text: resolved.error.message, errorCode: resolved.error.code }

      const maxChars = record === undefined ? undefined : readNumber(record, 'maxChars')
      try {
        const text = await readFile(resolved.value.absolute, 'utf8')
        return {
          ok: true,
          text: truncate(text, maxChars ?? 20_000),
          data: { path: resolved.value.absolute, relPath: resolved.value.relPath, bytes: text.length },
        }
      } catch (cause) {
        return { ok: false, text: `读取失败：${String(cause)}`, errorCode: 'ERR_NOT_FOUND' }
      }
    },
  }
}

export function fsListDirTool(deps: BuiltinToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'fs_list_dir',
      package: 'fs',
      description: '列出目录条目（workdir:// 相对项目工作目录；ro:// 相对只读平台资源）',
      paramsSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '虚拟路径，如 workdir://src' } },
        required: ['path'],
      },
      scope: 'workdir',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir', 'ro'],
      output: { maxChars: 8_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const path = record === undefined ? undefined : readString(record, 'path')
      if (path === undefined) return { ok: false, text: '缺少 path', errorCode: 'ERR_VALIDATION' }

      const resolved = deps.paths.resolve(path, context.roots)
      if (!resolved.ok) return { ok: false, text: resolved.error.message, errorCode: resolved.error.code }

      try {
        const entries = await readdir(resolved.value.absolute, { withFileTypes: true })
        const lines = await Promise.all(
          entries
            .filter((entry) => !entry.name.startsWith('.git'))
            .map(async (entry) => {
              const info = entry.isFile() ? await stat(join(resolved.value.absolute, entry.name)).catch(() => null) : null
              return `${entry.isDirectory() ? 'd' : '-'} ${entry.name}${info === null ? '' : ` (${info.size}B)`}`
            }),
        )
        return { ok: true, text: `${resolved.value.relPath}/\n${lines.sort().join('\n')}`, data: { count: entries.length } }
      } catch (cause) {
        return { ok: false, text: `列目录失败：${String(cause)}`, errorCode: 'ERR_NOT_FOUND' }
      }
    },
  }
}

export function fsSearchTool(deps: BuiltinToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  const MAX_FILES = 200
  const MAX_HITS = 40

  const walk = async (dir: string, depth: number, found: string[]): Promise<void> => {
    if (depth > 6 || found.length >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await walk(child, depth + 1, found)
      else if (entry.isFile() && /\.(ts|tsx|js|jsx|json|md|yml|yaml|txt|css|html)$/i.test(entry.name)) found.push(child)
    }
  }

  return {
    definition: {
      name: 'fs_search',
      package: 'fs',
      description: '在工作目录内按关键词搜索文本文件（简单子串匹配，最多返回若干条命中）',
      paramsSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（大小写不敏感）' },
          path: { type: 'string', description: '起始目录（默认 workdir://）' },
        },
        required: ['query'],
      },
      scope: 'workdir',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir', 'ro'],
      output: { maxChars: 8_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const query = record === undefined ? undefined : readString(record, 'query')
      if (query === undefined) return { ok: false, text: '缺少 query', errorCode: 'ERR_VALIDATION' }
      const startPath = (record === undefined ? undefined : readString(record, 'path')) ?? 'workdir://'

      const resolved = deps.paths.resolve(startPath, context.roots)
      if (!resolved.ok) return { ok: false, text: resolved.error.message, errorCode: resolved.error.code }

      const files: string[] = []
      await walk(resolved.value.absolute, 0, files)
      const needle = query.toLowerCase()
      const hits: string[] = []
      for (const file of files) {
        if (hits.length >= MAX_HITS) break
        try {
          const text = await readFile(file, 'utf8')
          const lines = text.split(/\r?\n/)
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? ''
            if (line.toLowerCase().includes(needle)) {
              hits.push(`${deps.paths.relativize(file, context.roots) ?? file}:${index + 1}: ${line.trim().slice(0, 160)}`)
              if (hits.length >= MAX_HITS) break
            }
          }
        } catch {
          // 二进制/不可读文件跳过
        }
      }
      return {
        ok: true,
        text: hits.length === 0 ? `未找到「${query}」（已扫描 ${files.length} 个文件）` : hits.join('\n'),
        data: { scanned: files.length, hits: hits.length },
      }
    },
  }
}

export function cmdRunTool(deps: BuiltinToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'cmd_run',
      package: 'cmd',
      description:
        '在项目工作目录内执行命令（结构化 argv，不经 shell）。高危命令（删除/安装依赖/改写历史等）需用户审批；禁止系统级与裸设备写入命令',
      paramsSchema: {
        type: 'object',
        properties: {
          program: { type: 'string', description: '可执行文件名，如 node / npm / git' },
          args: { type: 'array', items: { type: 'string' }, description: '参数数组（不要拼 shell）' },
          cwd: { type: 'string', description: '工作目录（默认 workdir://）' },
          timeoutMs: { type: 'number', description: '超时毫秒（默认 60000，上限 300000）' },
        },
        required: ['program'],
      },
      scope: 'workdir',
      risk: 'high',
      network: 'allowed',
      needsApproval: false, // 是否审批由 PolicyEngine 按命令风险判定（见 policyAction）
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir'],
      output: { maxChars: 12_000, strategy: 'truncate-tail' },
      policyAction: (input) => {
        const record = asRecord(input)
        const program = record === undefined ? undefined : readString(record, 'program')
        if (program === undefined) return null
        const rawArgs = record?.['args']
        const args = Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === 'string') : []
        return { kind: 'command', program, args }
      },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const program = record === undefined ? undefined : readString(record, 'program')
      if (program === undefined) return { ok: false, text: '缺少 program', errorCode: 'ERR_VALIDATION' }
      const rawArgs = record?.['args']
      const args = Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === 'string') : []
      const cwdPath = (record === undefined ? undefined : readString(record, 'cwd')) ?? 'workdir://'
      const timeoutMs = (record === undefined ? undefined : readNumber(record, 'timeoutMs')) ?? 60_000

      const resolved = deps.paths.resolve(cwdPath, context.roots)
      if (!resolved.ok) {
        return { ok: false, text: `工作目录非法：${resolved.error.message}`, errorCode: resolved.error.code }
      }

      const risk = classifyCommand(program, args)
      const result = await deps.cmd.run({
        program,
        args,
        cwd: resolved.value.absolute,
        timeoutMs,
        maxOutputChars: 12_000,
        signal: context.signal,
      })
      if (!result.ok) return { ok: false, text: result.error.message, errorCode: result.error.code }

      const value = result.value
      const header = `$ ${program} ${args.join(' ')}  （cwd=${resolved.value.relPath || '.'} exit=${value.exitCode ?? 'null'} ${value.durationMs}ms${value.timedOut ? ' 超时被杀' : ''}）`
      const body = [value.stdout.trim(), value.stderr.trim()].filter((part) => part.length > 0).join('\n')
      return {
        ok: value.exitCode === 0 && !value.timedOut,
        text: `${header}\n${body.length === 0 ? '（无输出）' : body}`,
        data: {
          exitCode: value.exitCode,
          timedOut: value.timedOut,
          truncated: value.truncated,
          riskRule: risk.ruleId,
        },
        ...(value.exitCode === 0 && !value.timedOut
          ? {}
          : { errorCode: value.timedOut ? 'ERR_CMD_TIMEOUT' : 'ERR_CMD_FORBIDDEN' }),
      }
    },
  }
}

export function approvalQueryTool(options: {
  readonly listOwn: (context: {
    readonly projectId: string
    readonly instanceId: string
  }) => Promise<Result<readonly { id: string; kind: string; status: string; summary: string }[]>>
}): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'approval_query',
      package: 'approval',
      description: '查看自己触发过的审批及其状态（用于等待用户决定后确认结果）',
      paramsSchema: { type: 'object', properties: {}, required: [] },
      scope: 'platform',
      risk: 'none',
      network: 'none',
      idempotent: true,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: [],
      output: { maxChars: 4_000, strategy: 'truncate-tail' },
    },
    async handler(_input, context): Promise<ToolOutcome> {
      const listed = await options.listOwn({ projectId: context.projectId, instanceId: context.instanceId })
      if (!listed.ok) return { ok: false, text: listed.error.message, errorCode: listed.error.code }
      if (listed.value.length === 0) return { ok: true, text: '你还没有触发过审批。' }
      return {
        ok: true,
        text: listed.value.map((item) => `#${item.id} [${item.status}] ${item.kind}: ${item.summary}`).join('\n'),
      }
    },
  }
}

export function registerBuiltinTools(registry: import('../../../ports/tools').ToolRegistry, deps: BuiltinToolDeps & {
  readonly listOwnApprovals: (context: {
    readonly projectId: string
    readonly instanceId: string
  }) => Promise<Result<readonly { id: string; kind: string; status: string; summary: string }[]>>
}): void {
  const tools = [
    fsReadFileTool(deps),
    fsListDirTool(deps),
    fsSearchTool(deps),
    cmdRunTool(deps),
    approvalQueryTool({ listOwn: deps.listOwnApprovals }),
  ]
  for (const tool of tools) registry.register(tool.definition, tool.handler)
}

export { ok as toolOk, err as toolErr }
