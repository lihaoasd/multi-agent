import type { LogFields, Logger } from '../src/ports/logger'

/** 静默 Logger（单测用）：不产生输出，保留 child 语义 */
export function createTestLogger(): Logger {
  const build = (): Logger => ({
    level: 'error',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => build(),
  })
  return build()
}

/** 记录型 Logger（断言日志内容时用） */
export function createRecordingLogger(): Logger & { records(): readonly LogFields[] } {
  const records: LogFields[] = []
  const build = (base: LogFields): Logger => ({
    level: 'debug',
    debug: (message, fields) => records.push({ level: 'debug', message, ...base, ...fields }),
    info: (message, fields) => records.push({ level: 'info', message, ...base, ...fields }),
    warn: (message, fields) => records.push({ level: 'warn', message, ...base, ...fields }),
    error: (message, fields) => records.push({ level: 'error', message, ...base, ...fields }),
    child: (fields) => build({ ...base, ...fields }),
  })
  return { ...build({}), records: () => records }
}
