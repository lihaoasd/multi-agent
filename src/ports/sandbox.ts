import type { Result } from '../shared/result'

/**
 * 命令执行端口（真源：docs/design/sandbox.md §4、abstraction.md §4.3）。
 * 约定：**结构化 argv，不经 shell**；cwd 必须已由 PathResolver 校验；超时杀进程树；输出截断。
 */
export interface CmdRunRequest {
  readonly program: string
  readonly args: readonly string[]
  /** 工作目录（绝对路径，已校验） */
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputChars: number
  readonly signal: AbortSignal
}

export interface CmdRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMs: number
}

export interface CmdRunner {
  run(request: CmdRunRequest): Promise<Result<CmdRunResult>>
}
