import { createLoopRegistry } from '../application/agent-loop/loop'
import { createPromptPreviewService, type PromptPreviewService } from '../application/agent-loop/preview'
import { createAgentLoopRunner } from '../application/agent-loop/runner'
import { registerBuiltinLoops } from '../application/agent-loop/strategies'
import { createApprovalService, type ApprovalService } from '../application/approval/approval-service'
import { createToolExecutor } from '../application/tools/tool-executor'
import { createDispatcher } from '../application/dispatcher/dispatcher'
import { createModelCatalog } from '../application/model-config/catalog'
import { createEventPipeline } from '../application/session/event-pipeline'
import { createSessionService, type SessionService } from '../application/session/session-service'
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
import { createWsEventHub } from '../infra/events/ws-hub'
import { createFileStore } from '../infra/file-store/file-store'
import { createModelConfigStore } from '../infra/file-store/model-config-store'
import { createDispatcherStateStore } from '../infra/file-store/dispatcher-state-store'
import { createProjectStore } from '../infra/file-store/project-store'
import { createSessionLogStore } from '../infra/file-store/session-log-store'
import { createSessionMetaStore } from '../infra/file-store/session-meta-store'
import { createApprovalStore } from '../infra/file-store/approval-store'
import { createRoleTemplateStore } from '../infra/file-store/role-template-store'
import { createDirectoryBrowser } from '../infra/fs/directory-browser'
import { createCmdRunner } from '../infra/sandbox/cmd-runner'
import { createPathResolver } from '../infra/sandbox/path-resolver'
import { registerBuiltinTools } from '../infra/tools/builtin'
import { createToolPackageRegistry, createToolRegistry } from '../infra/tools/registry'
import { createKeyedLockManager } from '../infra/lock/keyed-lock'
import { createModelGateway } from '../infra/model/gateway'
import { createYamlModelPresetProvider } from '../infra/model/presets'
import { createPolicyEngine } from '../domain/rules/policy'
import { createProviderKindRegistry, registerBuiltinProviderKinds } from '../infra/model/registry'
import { createStaticAssetProvider } from '../infra/static/static-assets'
import { createIdGenerator } from '../infra/util/id'
import { createLogger } from '../infra/util/logger'
import { systemClock } from '../infra/util/system-clock'
import type { Clock } from '../ports/clock'
import type { ConfigProvider } from '../ports/config'
import type { Container } from '../ports/container'
import type { EventBroadcaster } from '../ports/events'
import type { ApprovalStore } from '../ports/approval'
import type { FileStore } from '../ports/file-store'
import type { PathResolver } from '../ports/path-resolver'
import type { PolicyEngine } from '../ports/policy'
import type { CmdRunner } from '../ports/sandbox'
import type { ToolPackageRegistry, ToolRegistry } from '../ports/tools'
import type { DirectoryBrowser } from '../ports/fs-browse'
import type { LockManager } from '../ports/lock'
import type { Dispatcher } from '../ports/dispatcher'
import type { WsRealtime } from '../ports/events'
import type { ProjectStore } from '../ports/project'
import type { SessionLogStore, SessionMetaStore } from '../ports/session'
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
import type { LoopRegistry } from '../application/agent-loop/loop'
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
    TOKENS.SessionMetaStore,
    createSessionMetaStore({
      fileStore: container.resolve(TOKENS.FileStore),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.SessionLogStore,
    createSessionLogStore({
      fileStore: container.resolve(TOKENS.FileStore),
      metaStore: container.resolve(TOKENS.SessionMetaStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.DispatcherStateStore,
    createDispatcherStateStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(TOKENS.Realtime, createWsEventHub())
  container.registerInstance(TOKENS.PathResolver, createPathResolver())
  container.registerInstance(TOKENS.CmdRunner, createCmdRunner())
  container.registerInstance(TOKENS.PolicyEngine, createPolicyEngine())
  container.registerInstance(
    TOKENS.ApprovalStore,
    createApprovalStore({
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
    TOKENS.SessionMetaStore,
    TOKENS.SessionLogStore,
    TOKENS.DispatcherStateStore,
    TOKENS.Realtime,
    TOKENS.PathResolver,
    TOKENS.CmdRunner,
    TOKENS.PolicyEngine,
    TOKENS.ApprovalStore,
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
  readonly sessionMetaStore: SessionMetaStore
  readonly sessionLogStore: SessionLogStore
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
  readonly sessions: SessionService
  readonly dispatcher: Dispatcher
  readonly approvals: ApprovalService
  readonly toolRegistry: ToolRegistry
  readonly toolPackages: ToolPackageRegistry
  readonly loopRegistry: LoopRegistry
  readonly promptPreview: PromptPreviewService
  readonly realtime: WsRealtime
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
    /** 实时通道（默认取容器内的 WS Hub；测试可注入记录型实现） */
    realtime?: WsRealtime
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
  const realtime = overrides.realtime ?? container.resolve<WsRealtime>(TOKENS.Realtime)
  const broadcaster: EventBroadcaster = overrides.broadcaster ?? realtime
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

  const pipeline = createEventPipeline({
    logStore: container.resolve(TOKENS.SessionLogStore),
    broadcaster,
    clock,
  })

  const sessions = createSessionService({
    metaStore: container.resolve(TOKENS.SessionMetaStore),
    logStore: container.resolve(TOKENS.SessionLogStore),
    pipeline,
    projectStore: container.resolve(TOKENS.ProjectStore),
    clock,
  })

  const approvals = createApprovalService({
    store: container.resolve<ApprovalStore>(TOKENS.ApprovalStore),
    broadcaster,
    ids,
    clock,
  })

  const toolRegistry = createToolRegistry()
  registerBuiltinTools(toolRegistry, {
    paths: container.resolve<PathResolver>(TOKENS.PathResolver),
    cmd: container.resolve<CmdRunner>(TOKENS.CmdRunner),
    listOwnApprovals: async ({ projectId, instanceId }) => {
      const listed = await approvals.list(projectId, { actor: instanceId })
      return listed.ok
        ? { ok: true as const, value: listed.value.map((item) => ({ id: item.id, kind: item.kind, status: item.status, summary: item.summary })) }
        : listed
    },
  })
  const toolPackages = createToolPackageRegistry()
  const loopRegistry = createLoopRegistry()
  registerBuiltinLoops(loopRegistry)

  const toolExecutor = createToolExecutor({
    registry: toolRegistry,
    policy: container.resolve<PolicyEngine>(TOKENS.PolicyEngine),
  })

  const runner = createAgentLoopRunner({
    projects: container.resolve(TOKENS.ProjectStore),
    team,
    sessions,
    loops: loopRegistry,
    gateway: container.resolve(TOKENS.ModelGateway),
    tools: toolRegistry,
    toolExecutor,
    approvals,
    broadcaster,
    config: configProvider,
    clock,
    logger: container.resolve(TOKENS.Logger),
  })

  const promptPreview = createPromptPreviewService({
    projects: container.resolve(TOKENS.ProjectStore),
    team,
    tools: toolRegistry,
    config: configProvider,
  })

  const dispatcher = createDispatcher({
    stateStore: container.resolve(TOKENS.DispatcherStateStore),
    projectStore: container.resolve(TOKENS.ProjectStore),
    sessions,
    runner,
    approvals,
    broadcaster,
    lock: container.resolve(TOKENS.LockManager),
    clock,
    logger: container.resolve(TOKENS.Logger),
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
    sessionMetaStore: container.resolve(TOKENS.SessionMetaStore),
    sessionLogStore: container.resolve(TOKENS.SessionLogStore),
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
    sessions,
    dispatcher,
    approvals,
    toolRegistry,
    toolPackages,
    loopRegistry,
    promptPreview,
    realtime,
    broadcaster,
  }
}
