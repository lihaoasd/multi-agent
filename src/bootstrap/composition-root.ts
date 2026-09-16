import { createLoopRegistry } from '../application/agent-loop/loop'
import { createPromptPreviewService, type PromptPreviewService } from '../application/agent-loop/preview'
import { createAgentLoopRunner } from '../application/agent-loop/runner'
import { registerBuiltinLoops } from '../application/agent-loop/strategies'
import { createApprovalService, type ApprovalService } from '../application/approval/approval-service'
import { createMemoryService } from '../application/memory/memory-service'
import { createSearchService } from '../application/search/search-service'
import { createSummaryEngine, type SummaryEngine } from '../application/memory/summary-engine'
import { createArtifactService } from '../application/artifact/artifact-service'
import { createOrchestrationService } from '../application/orchestration/orchestration-service'
import { createTaskService } from '../application/task/task-service'
import { createQuestionService } from '../application/question/question-service'
import { createRecoveryService } from '../application/recovery/recovery-service'
import { createRuntimeService } from '../application/runtime/runtime-service'
import { createProjectExporter } from '../application/runtime/exporter'
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
import { createArtifactStore } from '../infra/file-store/artifact-store'
import { createTaskStore } from '../infra/file-store/task-store'
import { createOrchestrationStore } from '../infra/file-store/orchestration-store'
import { createQuestionStore } from '../infra/file-store/question-store'
import { createWorkdirFs } from '../infra/fs/workdir-fs'
import { createZipWriter } from '../infra/archive/zip'
import { createMemoryStore } from '../infra/file-store/memory-store'
import { createKeywordIndex } from '../infra/indexer/keyword-index'
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
import type { ArtifactService, ArtifactStore } from '../ports/artifact'
import type { OrchestrationService, OrchestrationStore } from '../ports/orchestration'
import type { ProjectExporter, RecoveryService, RuntimeService } from '../ports/runtime'
import type { QuestionService, QuestionStore } from '../ports/question'
import type { TaskService, TaskStore } from '../ports/task'
import type { WorkdirFs } from '../ports/workdir'
import type { MemoryService, MemoryStore } from '../ports/memory'
import type { SearchIndex, SearchService } from '../ports/search'
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
import { ok } from '../shared/result'
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

  // 4) 记忆与检索（L3 条目 + 派生倒排索引）
  container.registerInstance(
    TOKENS.MemoryStore,
    createMemoryStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.SearchIndex,
    createKeywordIndex({
      fileStore: container.resolve(TOKENS.FileStore),
      clock,
      dataDir: config.dataDir,
      sessionMetaStore: container.resolve(TOKENS.SessionMetaStore),
      sessionLogStore: container.resolve(TOKENS.SessionLogStore),
      memoryStore: container.resolve(TOKENS.MemoryStore),
    }),
  )

  // 5) 产出物 / 任务 / 询问（S6）
  container.registerInstance(TOKENS.WorkdirFs, createWorkdirFs())
  container.registerInstance(
    TOKENS.ArtifactStore,
    createArtifactStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.TaskStore,
    createTaskStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.QuestionStore,
    createQuestionStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
    }),
  )
  container.registerInstance(
    TOKENS.OrchestrationStore,
    createOrchestrationStore({
      fileStore: container.resolve(TOKENS.FileStore),
      lock: container.resolve(TOKENS.LockManager),
      clock,
      dataDir: config.dataDir,
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
    TOKENS.MemoryStore,
    TOKENS.SearchIndex,
    TOKENS.WorkdirFs,
    TOKENS.ArtifactStore,
    TOKENS.TaskStore,
    TOKENS.QuestionStore,
    TOKENS.OrchestrationStore,
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
  readonly memory: MemoryService
  readonly search: SearchService
  readonly summary: SummaryEngine
  readonly artifacts: ArtifactService
  readonly tasks: TaskService
  readonly questions: QuestionService
  readonly orchestration: OrchestrationService
  readonly runtime: RuntimeService
  readonly recovery: RecoveryService
  readonly exporter: ProjectExporter
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
    /** 模型网关替身（测试/验收的脚本化替身用；缺省取容器内的真实网关） */
    gateway?: ModelGateway
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
  const gateway = overrides.gateway ?? container.resolve<ModelGateway>(TOKENS.ModelGateway)
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

  const memory = createMemoryService({
    store: container.resolve<MemoryStore>(TOKENS.MemoryStore),
    ids,
    clock,
    config: configProvider,
  })

  const search = createSearchService({
    index: container.resolve<SearchIndex>(TOKENS.SearchIndex),
    memory,
  })

  // 产出物/任务/询问服务：任务与询问的"通知并唤醒一轮"在这里收口（D18-③）
  const artifacts = createArtifactService({
    store: container.resolve<ArtifactStore>(TOKENS.ArtifactStore),
    workdir: container.resolve<WorkdirFs>(TOKENS.WorkdirFs),
    projects: container.resolve(TOKENS.ProjectStore),
    lock: container.resolve(TOKENS.LockManager),
    ids,
    clock,
    logger: container.resolve(TOKENS.Logger),
  })

  const notifier: { wake?: (input: { projectId: string; instanceId: string; text: string }) => Promise<void> } = {}
  const wake = async (input: { projectId: string; instanceId: string; text: string }): Promise<void> => {
    if (notifier.wake === undefined) return
    await notifier.wake(input)
  }

  const orchestration = createOrchestrationService({
    store: container.resolve<OrchestrationStore>(TOKENS.OrchestrationStore),
    projects: container.resolve(TOKENS.ProjectStore),
    ids,
    clock,
    broadcaster,
    logger: container.resolve(TOKENS.Logger),
  })

  const tasks = createTaskService({
    store: container.resolve<TaskStore>(TOKENS.TaskStore),
    projects: container.resolve(TOKENS.ProjectStore),
    artifacts,
    orchestration,
    ids,
    clock,
    broadcaster,
    logger: container.resolve(TOKENS.Logger),
    notify: wake,
  })

  const questions = createQuestionService({
    store: container.resolve<QuestionStore>(TOKENS.QuestionStore),
    broadcaster,
    ids,
    clock,
    logger: container.resolve(TOKENS.Logger),
    notify: wake,
  })

  const toolRegistry = createToolRegistry()
  registerBuiltinTools(toolRegistry, {
    paths: container.resolve<PathResolver>(TOKENS.PathResolver),
    cmd: container.resolve<CmdRunner>(TOKENS.CmdRunner),
    memory,
    search,
    artifacts,
    tasks,
    activeTaskId: async ({ projectId, instanceId }) => {
      const active = await tasks.activeFor(projectId, instanceId)
      return active.ok ? (active.value?.id ?? null) : null
    },
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

  const summary = createSummaryEngine({
    sessions,
    memory,
    gateway,
    resolveModel: async (projectId, instanceId) => {
      const effective = await team.effectiveConfig(projectId, instanceId)
      return effective.ok ? ok(effective.value.model) : effective
    },
    lock: container.resolve(TOKENS.LockManager),
    ids,
    clock,
    config: configProvider,
    logger: container.resolve(TOKENS.Logger),
  })

  const runner = createAgentLoopRunner({
    projects: container.resolve(TOKENS.ProjectStore),
    team,
    sessions,
    loops: loopRegistry,
    gateway,
    tools: toolRegistry,
    toolExecutor,
    approvals,
    memory,
    search,
    summary,
    tasks,
    questions,
    artifacts,
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
    memory,
    tasks,
    artifacts,
  })

  const dispatcher = createDispatcher({
    stateStore: container.resolve(TOKENS.DispatcherStateStore),
    projectStore: container.resolve(TOKENS.ProjectStore),
    sessions,
    runner,
    approvals,
    questions,
    broadcaster,
    lock: container.resolve(TOKENS.LockManager),
    clock,
    logger: container.resolve(TOKENS.Logger),
  })

  // 通知并唤醒一轮（D18-③）：向该角色的 user 会话注入一条系统消息，再触发 drain 处理它
  notifier.wake = async (input) => {
    const appended = await sessions.append(input.projectId, sessions.sessionIdFor(input.instanceId), [
      {
        kind: 'message',
        turn: 0,
        payload: { role: 'user', sender: 'system', text: input.text, content: { text: input.text } },
      },
    ])
    if (!appended.ok) return
    await dispatcher.drain(input.projectId, input.instanceId)
  }

  // S8：未完成回合恢复 + 运行控制 + 项目导出
  const recovery = createRecoveryService({
    sessions,
    clock,
    wake,
    projectSessions: async (projectId) => {
      const listed = await sessions.list(projectId)
      return listed.ok
        ? { ok: true as const, value: listed.value.map((item) => ({ sessionId: item.sessionId, instanceId: item.instanceId })) }
        : listed
    },
  })

  const runtime = createRuntimeService({
    projects: container.resolve(TOKENS.ProjectStore),
    sessions,
    tasks,
    recovery,
    dispatcher,
    stateStore: container.resolve(TOKENS.DispatcherStateStore),
    clock,
    logger: container.resolve(TOKENS.Logger),
  })

  const exporter = createProjectExporter({
    fileStore: container.resolve(TOKENS.FileStore),
    projects: container.resolve(TOKENS.ProjectStore),
    zip: createZipWriter(),
    dataDir: config.dataDir,
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
    gateway,
    modelConfig,
    agentConfig,
    project,
    team,
    sessions,
    dispatcher,
    approvals,
    memory,
    search,
    summary,
    artifacts,
    tasks,
    questions,
    orchestration,
    runtime,
    recovery,
    exporter,
    toolRegistry,
    toolPackages,
    loopRegistry,
    promptPreview,
    realtime,
    broadcaster,
  }
}
