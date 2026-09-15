import type { LogFields, LogLevel, LogSink, Logger } from '../../ports/logger'

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerOptions {
  readonly level?: LogLevel
  readonly sink?: LogSink
  /** 固定字段（子 logger 会合并） */
  readonly base?: LogFields
  /** 时间来源，测试可注入固定值 */
  readonly now?: () => Date
}

/** 默认输出：stdout，一行一条 JSON（便于重定向与检索） */
export const stdoutSink: LogSink = {
  write: (line: string) => {
    process.stdout.write(line)
  },
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const sink = options.sink ?? stdoutSink
  const now = options.now ?? (() => new Date())
  const base = options.base ?? {}
  const threshold = LEVEL_ORDER[level]

  const build = (fixed: LogFields): Logger => {
    const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[recordLevel] < threshold) return
      const record: Record<string, unknown> = {
        ts: now().toISOString(),
        level: recordLevel,
        msg: message,
        ...fixed,
        ...(fields ?? {}),
      }
      sink.write(`${JSON.stringify(record)}\n`)
    }
    return {
      level,
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
      child: (fields) => build({ ...fixed, ...fields }),
    }
  }

  return build(base)
}

/** 内存 sink（测试用）：可取出已写入的行 */
export function createMemorySink(): LogSink & { lines(): readonly string[] } {
  const written: string[] = []
  return {
    write: (line: string) => {
      written.push(line)
    },
    lines: () => written,
  }
}
