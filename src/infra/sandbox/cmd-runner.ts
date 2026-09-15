import { spawn } from 'node:child_process'
import type { CmdRunner, CmdRunRequest, CmdRunResult } from '../../ports/sandbox'
import { err, ok, type Result } from '../../shared/result'

export interface CmdRunnerOptions {
  /** 硬上限（超过即拒绝，避免一次 sleep 一天） */
  readonly maxTimeoutMs?: number
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(text.length - maxChars)}\n…（输出已截断，保留末尾 ${maxChars} 字符）`, truncated: true }
}

/**
 * 命令执行器（sandbox.md §4）：**结构化 argv、不经 shell**、cwd 由调用方锁定、超时杀进程树、
 * 输出截断（保留末尾，便于看错误）。交互式/长驻进程不在 MVP 支持范围（由策略层拒绝）。
 */
export function createCmdRunner(options: CmdRunnerOptions = {}): CmdRunner {
  const maxTimeoutMs = options.maxTimeoutMs ?? 300_000

  return {
    async run(request: CmdRunRequest): Promise<Result<CmdRunResult>> {
      if (request.program.trim().length === 0) {
        return err('ERR_VALIDATION', 'program 不能为空')
      }
      // 不做 shell 解析：program 必须是单个可执行名（含路径分隔符可以），出现 shell 元字符直接拒绝
      if (/[\s;&|><`$(){}]/.test(request.program)) {
        return err('ERR_CMD_FORBIDDEN', '不支持 shell 语法：请用 program + args 分开传参', {
          program: request.program,
        })
      }
      const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs, maxTimeoutMs))
      const startedAt = Date.now()

      return new Promise<Result<CmdRunResult>>((resolvePromise) => {
        let settled = false
        let stdout = ''
        let stderr = ''
        let truncated = false
        let timedOut = false

        const child = spawn(request.program, [...request.args], {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1' },
        })

        const killTree = (): void => {
          try {
            if (process.platform === 'win32' && child.pid !== undefined) {
              spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
            } else {
              child.kill('SIGKILL')
            }
          } catch {
            // 尽力而为
          }
        }

        const timer = setTimeout(() => {
          timedOut = true
          killTree()
        }, timeoutMs)

        const onAbort = (): void => {
          timedOut = true
          killTree()
        }
        request.signal.addEventListener('abort', onAbort, { once: true })

        const collect = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
          const text = chunk.toString('utf8')
          if (target === 'stdout') stdout += text
          else stderr += text
          if (stdout.length + stderr.length > request.maxOutputChars * 4) {
            truncated = true
            const stdoutLimited = truncate(stdout, request.maxOutputChars)
            const stderrLimited = truncate(stderr, request.maxOutputChars)
            stdout = stdoutLimited.text
            stderr = stderrLimited.text
          }
        }

        child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
        child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))

        const finish = (exitCode: number | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          request.signal.removeEventListener('abort', onAbort)
          const out = truncate(stdout, request.maxOutputChars)
          const errorOut = truncate(stderr, request.maxOutputChars)
          resolvePromise(
            ok({
              exitCode,
              stdout: out.text,
              stderr: errorOut.text,
              truncated: truncated || out.truncated || errorOut.truncated,
              timedOut,
              durationMs: Date.now() - startedAt,
            }),
          )
        }

        child.on('error', (cause: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          request.signal.removeEventListener('abort', onAbort)
          resolvePromise(
            err('ERR_CMD_FORBIDDEN', `无法执行命令：${cause.message}`, { program: request.program }),
          )
        })
        child.on('close', (code: number | null) => finish(code))
      })
    },
  }
}
