import type { Clock } from './clock'
import type { ConfigProvider } from './config'
import { token, type Token } from './container'
import type { FileStore } from './file-store'
import type { IdGenerator } from './id'
import type { Logger } from './logger'
import type { ModelGateway } from './model'
import type {
  ModelCatalog,
  ModelConfigStore,
  ModelPresetProvider,
  ProviderKindRegistry,
  SecretResolver,
} from './model-config'
import type { RoleTemplateStore } from './role-templates'
import type { StaticAssetProvider } from './static-assets'

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
  // 存储
  FileStore: token<FileStore>('FileStore'),
  // 模型
  ModelConfigStore: token<ModelConfigStore>('ModelConfigStore'),
  ModelPresetProvider: token<ModelPresetProvider>('ModelPresetProvider'),
  SecretResolver: token<SecretResolver>('SecretResolver'),
  ProviderKindRegistry: token<ProviderKindRegistry>('ProviderKindRegistry'),
  ModelCatalog: token<ModelCatalog>('ModelCatalog'),
  ModelGateway: token<ModelGateway>('ModelGateway'),
  // Agent 模板
  RoleTemplateStore: token<RoleTemplateStore>('RoleTemplateStore'),
} as const

export type KnownToken = Token<unknown>
