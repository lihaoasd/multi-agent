import { createEnvConfigProvider, loadAppConfig, type LoadAppConfigOptions } from '../infra/config/env-config'
import { createStaticAssetProvider } from '../infra/static/static-assets'
import { createIdGenerator } from '../infra/util/id'
import { createLogger } from '../infra/util/logger'
import { systemClock } from '../infra/util/system-clock'
import type { Clock } from '../ports/clock'
import type { Container } from '../ports/container'
import type { IdGenerator } from '../ports/id'
import type { Logger } from '../ports/logger'
import type { StaticAssetProvider } from '../ports/static-assets'
import { TOKENS } from '../ports/tokens'
import type { AppConfig } from '../shared/config'
import { createContainer } from './container'

/** web 构建产物候选目录（相对 cwd），供 server 静态托管 */
export const DEFAULT_WEB_DIST_CANDIDATES = ['web/dist'] as const

export interface BuildContainerOptions extends LoadAppConfigOptions {
  /** 预解析配置（测试/嵌入场景直接注入，跳过 `.env` 读取） */
  readonly config?: AppConfig
  readonly logger?: Logger
  readonly webDistCandidates?: readonly string[]
}

/**
 * 组合根（唯一装配处，abstraction.md §5.4）。
 * 只在此处 import infra 实现；业务层只认端口。装配完成后 `assertGraph` 暴露缺失依赖。
 */
export function buildContainer(options: BuildContainerOptions = {}): Container {
  const container = createContainer()
  const config = options.config ?? loadAppConfig(options)
  const logger = options.logger ?? createLogger({ level: 'info' })
  const webDistCandidates = options.webDistCandidates ?? DEFAULT_WEB_DIST_CANDIDATES

  container.registerInstance(TOKENS.Config, createEnvConfigProvider(config))
  container.registerInstance(TOKENS.Clock, systemClock)
  container.registerInstance(TOKENS.IdGenerator, createIdGenerator())
  container.registerInstance(TOKENS.Logger, logger)
  container.registerInstance(TOKENS.StaticAssets, createStaticAssetProvider(webDistCandidates))

  container.assertGraph([TOKENS.Config, TOKENS.Clock, TOKENS.IdGenerator, TOKENS.Logger, TOKENS.StaticAssets])
  return container
}

/** 启动期解析出的依赖集合（server 与后续用例都从这里取，不再直接碰容器） */
export interface AppDeps {
  readonly config: AppConfig
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly staticAssets: StaticAssetProvider
}

export function resolveDeps(container: Container): AppDeps {
  return {
    config: container.resolve(TOKENS.Config).get(),
    clock: container.resolve(TOKENS.Clock),
    ids: container.resolve(TOKENS.IdGenerator),
    logger: container.resolve(TOKENS.Logger),
    staticAssets: container.resolve(TOKENS.StaticAssets),
  }
}
