import { createModelCatalog } from '../application/model-config/catalog'
import { createProjectService, type ProjectService } from '../application/project/service'
import { createTeamService, type TeamService } from '../application/team/team-service'
import { createTemplateModelReferenceQuery } from '../application/model-config/references'
import { createModelConfigService, type ModelConfigService } from '../application/model-config/service'
import { createAgentConfigService, type AgentConfigService } from '../application/team/agent-config-service'
import {
  createEnvConfigProvider,
  loadEnvMap,
  type LoadAppConfigOptions,
} from '../infra/config/env-config'
import { createSecretResolver } from '../infra/config/secret-resolver'
import { createNoopEventBroadcaster } from '../infra/events/noop-broadcaster'
import { createFileStore } from '../infra/file-store/file-store'
import { createModelConfigStore } from '../infra/file-store/model-config-store'
import { createProjectStore } from '../infra/file-store/project-store'
import { createRoleTemplateStore } from '../infra/file-store/role-template-store'
import { createDirectoryBrowser } from '../infra/fs/directory-browser'
import { createKeyedLockManager } from '../infra/lock/keyed-lock'
import { createModelGateway } from '../infra/model/gateway'
import { createYamlModelPresetProvider } from '../infra/model/presets'
import { createProviderKindRegistry, registerBuiltinProviderKinds } from '../infra/model/registry'
import { createStaticAssetProvider } from '../infra/static/static-assets'
import { createIdGenerator } from '../infra/util/id'
import { createLogger } from '../infra/util/logger'
import { systemClock } from '../infra/util/system-clock'
import type { Clock } from '../ports/clock'
import type { ConfigProvider } from '../ports/config'
import type { Container } from '../ports/container'
import type { EventBroadcaster } from '../ports/events'
import type { FileStore } from '../ports/file-store'
import type { DirectoryBrowser } from '../ports/fs-browse'
import type { LockManager } from '../ports/lock'
import type { ProjectStore } from '../ports/project'
import type { IdGenerator } from '../ports/id'
import type { Logger } from '../ports/logger'
import type { ModelGateway } from '../ports/model'
import type {
  ModelCatalog,
  ModelConfigStore,
  ModelPresetProvider,
  ProviderKindRegistry,
  SecretResolver,
} from '../ports/model-config'
import type { RoleTemplateStore } from '../ports/role-templates'
import type { StaticAssetProvider } from '../ports/static-assets'
import { TOKENS } from '../ports/tokens'
import { buildAppConfig, type AppConfig } from '../shared/config'
import { resolve } from 'node:path'
import { createContainer } from './container'

/** web 构建产物候选目录（相对 cwd），供 server 静态托管 */
export const DEFAULT_WEB_DIST_CANDIDATES = ['web/dist'] as const
/** 模型配置文件相对 cwd 的默认位置 */
export const DEFAULT_MODEL_CONFIG_PATH = 'data/model-config.json'
export const DEFAULT_PRESET_PATH = 'src/shared/model-presets.yaml'

export interface BuildContainerOptions extends LoadAppConfigOptions {
  /** 预解析配置（测试/嵌入场景直接注入，跳过 `.env` 读取） */
  readonly config?: AppConfig
  /** 预合并的环境映射（`.env` + 进程环境）；给出则不再自行读 `.env` */
  readonly envMap?: Readonly<Record<string, string | undefined>>
  readonly logger?: Logger
  readonly webDistCandidates?: readonly string[]
  /** 文件存储根（默认 cwd）；测试指向临时目录 */
  readonly fileStoreRoot?: string
}

/**
 * 组合根（唯一装配处，abstraction.md §5.4）。
 * 只在此处 import infra 实现；业务层只认端口。装配完成后 `assertGraph` 暴露缺失依赖。
 */
export function buildContainer(options: BuildContainerOptions = {}): Container {
  const container = createContainer()
  // `.env` 文件内容不会写回 process.env，故统一用合并后的 envMap（配置解析与遗留导入共用同一份）
  const envMap =
    options.envMap ??
    (options.config === undefined
      ? loadEnvMap({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
          ...(options.env === undefined ? {} : { env: options.env }),
        })
      : {})
  const config = options.config ?? buildAppConfig(envMap)
  const logger = options.logger ?? createLogger({ level: 'info' })
  const webDistCandidates = options.webDistCandidates ?? DEFAULT_WEB_DIST_CANDIDATES
  const clock = systemClock
  const ids = createIdGenerator()

  // 1) 平台
  container.registerInstance(TOKENS.Config, createEnvConfigProvider(config))
  container.registerInstance(TOKENS.Clock, clock)
  container.registerInstance(TOKENS.IdGenerator, ids)
  container.registerInstance(TOKENS.Logger, logger)
  container.registerInstance(TOKENS.StaticAssets, createStaticAssetProvider(webDistCandidates))

  // 2) 存储
  container.registerInstance(
    TOKENS.FileStore,
    createFileStore({ root: options.fileStoreRoot ?? process.cwd() }),
  )
  container.registerInstance(
    TOKENS.ModelConfigStore,
    createModelConfigStore({
      fileStore: container.resolve(TOKENS.FileStore),
      path: config.models.configFile || DEFAULT_MODEL_CONFIG_PATH,
      auditPath: `${config.dataDir}/config-audit.jsonl`,
    }),
  )
  container.registerInstance(TOKENS.LockManager, createKeyedLockManager())
  container.registerInstance(TOKENS.DirectoryBrowser, createDirectoryBrowser())
  container.registerInstance(
    TOKENS.ProjectStore,
    createProjectStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.RoleTemplateStore,
    createRoleTemplateStore({
      fileStore: container.resolve(TOKENS.FileStore),
      roleDirs: config.roleDirs,
      dataDir: config.dataDir,
      clock,
    }),
  )

  // 3) 模型
  const presets = createYamlModelPresetProvider(DEFAULT_PRESET_PATH)
  // 启动自检：预置目录随仓库只读，坏了必须立刻暴露（否则每次请求都 500）
  try {
    presets.list()
  } catch (cause) {
    throw new Error(`ERR_INTERNAL: 内置预置目录不可用（${DEFAULT_PRESET_PATH}）`, { cause })
  }
  container.registerInstance(TOKENS.ModelPresetProvider, presets)
  container.registerInstance(TOKENS.SecretResolver, createSecretResolver(envMap))
  const kinds = createProviderKindRegistry()
  registerBuiltinProviderKinds(kinds)
  container.registerInstance(TOKENS.ProviderKindRegistry, kinds)
  container.registerInstance(
    TOKENS.ModelCatalog,
    createModelCatalog({
      store: container.resolve(TOKENS.ModelConfigStore),
      secrets: container.resolve(TOKENS.SecretResolver),
      clock,
      defaultTimeoutMs: config.models.requestTimeoutMs,
    }),
  )
  container.registerInstance(
    TOKENS.ModelGateway,
    createModelGateway({
      catalog: container.resolve<ModelCatalog>(TOKENS.ModelCatalog),
      kinds,
    }),
  )

  container.assertGraph([
    TOKENS.Config,
    TOKENS.Clock,
    TOKENS.IdGenerator,
    TOKENS.Logger,
    TOKENS.StaticAssets,
    TOKENS.FileStore,
    TOKENS.LockManager,
    TOKENS.DirectoryBrowser,
    TOKENS.ProjectStore,
    TOKENS.ModelConfigStore,
    TOKENS.RoleTemplateStore,
    TOKENS.ModelPresetProvider,
    TOKENS.SecretResolver,
    TOKENS.ProviderKindRegistry,
    TOKENS.ModelCatalog,
    TOKENS.ModelGateway,
  ])
  return container
}

/** 启动期解析出的依赖集合（server 与用例都从这里取，业务代码不再直接碰容器） */
export interface AppDeps {
  readonly config: AppConfig
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly staticAssets: StaticAssetProvider
  readonly fileStore: FileStore
  readonly lock: LockManager
  readonly directoryBrowser: DirectoryBrowser
  readonly projectStore: ProjectStore
  readonly modelConfigStore: ModelConfigStore
  readonly roleTemplateStore: RoleTemplateStore
  readonly presets: ModelPresetProvider
  readonly secrets: SecretResolver
  readonly kinds: ProviderKindRegistry
  readonly catalog: ModelCatalog
  readonly gateway: ModelGateway
  readonly modelConfig: ModelConfigService
  readonly agentConfig: AgentConfigService
  readonly project: ProjectService
  readonly team: TeamService
  readonly broadcaster: EventBroadcaster
}

/**
 * 应用服务装配：把端口组合成用例（model-config / agent-config）。
 * 以后新增服务在此登记，server 只接收装配好的 `ServerServices`。
 */
export function resolveDeps(
  container: Container,
  overrides: {
    broadcaster?: EventBroadcaster
    /** 遗留键（MODELS__PROVIDERS）读取来源；默认进程环境 */
    envMap?: Readonly<Record<string, string | undefined>>
  } = {},
): AppDeps {
  const configProvider = container.resolve<ConfigProvider>(TOKENS.Config)
  const config = configProvider.get()
  const catalog = container.resolve<ModelCatalog>(TOKENS.ModelCatalog)
  const modelConfigStore = container.resolve<ModelConfigStore>(TOKENS.ModelConfigStore)
  const roleTemplateStore = container.resolve<RoleTemplateStore>(TOKENS.RoleTemplateStore)
  const clock = container.resolve(TOKENS.Clock)
  const ids = container.resolve(TOKENS.IdGenerator)
  const broadcaster = overrides.broadcaster ?? createNoopEventBroadcaster()
  const envMap = overrides.envMap ?? process.env

  const modelConfig = createModelConfigService({
    store: modelConfigStore,
    catalog,
    presets: container.resolve(TOKENS.ModelPresetProvider),
    kinds: container.resolve(TOKENS.ProviderKindRegistry),
    secrets: container.resolve(TOKENS.SecretResolver),
    references: createTemplateModelReferenceQuery(roleTemplateStore),
    ids,
    clock,
    config: configProvider,
    readLegacyEnvProviders: () => {
      const raw = envMap['MODELS__PROVIDERS']
      if (raw === undefined || raw.trim().length === 0) return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    },
  })

  const agentConfig = createAgentConfigService({
    store: roleTemplateStore,
    catalog,
    audit: modelConfigStore,
    ids,
    clock,
    config: configProvider,
  })

  const project = createProjectService({
    store: container.resolve(TOKENS.ProjectStore),
    roleTemplates: roleTemplateStore,
    browser: container.resolve(TOKENS.DirectoryBrowser),
    ids,
    clock,
    config: configProvider,
    platformDataRoot: resolve(process.cwd(), config.dataDir),
  })

  const team = createTeamService({
    store: container.resolve(TOKENS.ProjectStore),
    roleTemplates: roleTemplateStore,
    catalog,
    audit: modelConfigStore,
    ids,
    clock,
    config: configProvider,
  })

  return {
    config,
    clock,
    ids,
    logger: container.resolve(TOKENS.Logger),
    staticAssets: container.resolve(TOKENS.StaticAssets),
    fileStore: container.resolve(TOKENS.FileStore),
    lock: container.resolve(TOKENS.LockManager),
    directoryBrowser: container.resolve(TOKENS.DirectoryBrowser),
    projectStore: container.resolve(TOKENS.ProjectStore),
    modelConfigStore,
    roleTemplateStore,
    presets: container.resolve(TOKENS.ModelPresetProvider),
    secrets: container.resolve(TOKENS.SecretResolver),
    kinds: container.resolve(TOKENS.ProviderKindRegistry),
    catalog,
    gateway: container.resolve(TOKENS.ModelGateway),
    modelConfig,
    agentConfig,
    project,
    team,
    broadcaster,
  }
}
