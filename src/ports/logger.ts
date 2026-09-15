/** 结构化日志端口（每行一条 JSON；审计事件走独立审计通道，见 model-config §10） */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  readonly [key: string]: unknown
}

/** 输出目标（默认 stdout；测试可注入内存 sink） */
export interface LogSink {
  write(line: string): void
}

export interface Logger {
  readonly level: LogLevel
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 派生带固定字段的 logger（如 { projectId }） */
  child(fields: LogFields): Logger
}
