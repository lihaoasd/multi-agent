import type { AppConfig } from '../shared/config'

/** 平台配置提供者（`.env` 加载 + 默认值 + 类型校验；默认适配器 infra/config） */
export interface ConfigProvider {
  get(): AppConfig
}
