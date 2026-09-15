import type { SessionLogStore, SessionMetaStore } from './session'
import type { DispatcherStateStore } from './dispatcher'
import type { WsRealtime } from './events'
import type { Clock } from './clock'
import type { ConfigProvider } from './config'
import { token, type Token } from './container'
import type { FileStore } from './file-store'
import type { DirectoryBrowser } from './fs-browse'
import type { IdGenerator } from './id'
import type { LockManager } from './lock'
import type { Logger } from './logger'
import type { MemoryStore } from './memory'
import type { ModelGateway } from './model'
import type {
  ModelCatalog,
  ModelConfigStore,
  ModelPresetProvider,
  ProviderKindRegistry,
  SecretResolver,
} from './model-config'
import type { ApprovalStore } from './approval'
import type { ArtifactStore } from './artifact'
import type { QuestionStore } from './question'
import type { TaskStore } from './task'
import type { WorkdirFs } from './workdir'
import type { PathResolver } from './path-resolver'
import type { PolicyEngine } from './policy'
import type { ProjectStore } from './project'
import type { CmdRunner } from './sandbox'
import type { RoleTemplateStore } from './role-templates'
import type { SearchIndex } from './search'
import type { StaticAssetProvider } from './static-assets'
import type { TurnRunner } from './turn'

/**
 * 全局 Token 注册表（唯一一处定义；键名与接口名一致，见 abstraction.md §5.2）。
 * 每新增一个端口，在此登记一个 Token；未登记即无法装配。
 */
export const TOKENS = {
  // 平台
  Config: token<ConfigProvider>('ConfigProvider'),
  Clock: token<Clock>('Clock'),
  IdGenerator: token<IdGenerator>('IdGenerator'),
  Logger: token<Logger>('Logger'),
  StaticAssets: token<StaticAssetProvider>('StaticAssetProvider'),
  Realtime: token<WsRealtime>('WsRealtime'),
  // 存储
  FileStore: token<FileStore>('FileStore'),
  LockManager: token<LockManager>('LockManager'),
  DirectoryBrowser: token<DirectoryBrowser>('DirectoryBrowser'),
  ProjectStore: token<ProjectStore>('ProjectStore'),
  SessionMetaStore: token<SessionMetaStore>('SessionMetaStore'),
  SessionLogStore: token<SessionLogStore>('SessionLogStore'),
  DispatcherStateStore: token<DispatcherStateStore>('DispatcherStateStore'),
  ApprovalStore: token<ApprovalStore>('ApprovalStore'),
  MemoryStore: token<MemoryStore>('MemoryStore'),
  SearchIndex: token<SearchIndex>('SearchIndex'),
  ArtifactStore: token<ArtifactStore>('ArtifactStore'),
  TaskStore: token<TaskStore>('TaskStore'),
  QuestionStore: token<QuestionStore>('QuestionStore'),
  WorkdirFs: token<WorkdirFs>('WorkdirFs'),
  // 模型
  ModelConfigStore: token<ModelConfigStore>('ModelConfigStore'),
  ModelPresetProvider: token<ModelPresetProvider>('ModelPresetProvider'),
  SecretResolver: token<SecretResolver>('SecretResolver'),
  ProviderKindRegistry: token<ProviderKindRegistry>('ProviderKindRegistry'),
  ModelCatalog: token<ModelCatalog>('ModelCatalog'),
  ModelGateway: token<ModelGateway>('ModelGateway'),
  // 执行与沙箱
  PathResolver: token<PathResolver>('PathResolver'),
  CmdRunner: token<CmdRunner>('CmdRunner'),
  PolicyEngine: token<PolicyEngine>('PolicyEngine'),
  // 回合执行
  TurnRunner: token<TurnRunner>('TurnRunner'),
  // Agent 模板
  RoleTemplateStore: token<RoleTemplateStore>('RoleTemplateStore'),
} as const

export type KnownToken = Token<unknown>
