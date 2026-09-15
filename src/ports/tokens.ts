import type { Clock } from './clock'
import type { ConfigProvider } from './config'
import { token, type Token } from './container'
import type { IdGenerator } from './id'
import type { Logger } from './logger'
import type { StaticAssetProvider } from './static-assets'

/**
 * 全局 Token 注册表（唯一一处定义；键名与接口名一致，见 abstraction.md §5.2）。
 * 每新增一个端口，在此登记一个 Token；未登记即无法装配。
 */
export const TOKENS = {
  Config: token<ConfigProvider>('ConfigProvider'),
  Clock: token<Clock>('Clock'),
  IdGenerator: token<IdGenerator>('IdGenerator'),
  Logger: token<Logger>('Logger'),
  StaticAssets: token<StaticAssetProvider>('StaticAssetProvider'),
} as const

export type KnownToken = Token<unknown>
