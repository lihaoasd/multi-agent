/** 当前时间（可注入固定时钟，便于测试与审计一致性） */
export interface Clock {
  now(): Date
}
