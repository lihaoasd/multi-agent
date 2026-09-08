/** 分级日志（写到 stdout，带时间戳与级别标签）。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m', // 灰
  info: '\x1b[36m', // 青
  warn: '\x1b[33m', // 黄
  error: '\x1b[31m', // 红
}
const RESET = '\x1b[0m'

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(ns: string): Logger
}

function ts(): string {
  return new Date().toISOString()
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return ''
  return ' ' + args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly ns: string,
    private readonly useColor: boolean,
  ) {}

  private write(lvl: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[this.level]) return
    const color = this.useColor ? LEVEL_COLOR[lvl] : ''
    const reset = this.useColor ? RESET : ''
    const line = `${ts()} ${color}${lvl.toUpperCase().padEnd(5)}${reset} [${this.ns}] ${msg}${formatArgs(args)}`
    if (lvl === 'error') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write('debug', msg, args)
  }
  info(msg: string, ...args: unknown[]): void {
    this.write('info', msg, args)
  }
  warn(msg: string, ...args: unknown[]): void {
    this.write('warn', msg, args)
  }
  error(msg: string, ...args: unknown[]): void {
    this.write('error', msg, args)
  }
  child(ns: string): Logger {
    return new ConsoleLogger(this.level, `${this.ns}:${ns}`, this.useColor)
  }
}

/** 全局 root logger（ns='haness'）。级别来自 LOG_LEVEL 环境变量，默认 info。 */
export function rootLogger(): Logger {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  const level: LogLevel = LEVEL_ORDER[env as LogLevel] !== undefined ? (env as LogLevel) : 'info'
  const useColor = process.env.NO_COLOR !== '1' && !!(process.stdout.isTTY ?? false)
  return new ConsoleLogger(level, 'haness', useColor)
}
