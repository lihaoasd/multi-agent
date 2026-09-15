import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConfigProvider } from '../../ports/config'
import { buildAppConfig, parseEnvText, type AppConfig } from '../../shared/config'

export interface LoadAppConfigOptions {
  /** 工作目录（默认 process.cwd()） */
  readonly cwd?: string
  /** `.env` 相对路径；传 null 表示只读环境变量 */
  readonly envFile?: string | null
  /** 环境变量来源（默认 process.env），测试可注入 */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** 读 `.env` 文本；不存在或读取失败视作空（配置回退内置默认值，不阻断启动） */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return parseEnvText(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 平台配置加载：`.env` 文件 + 进程环境变量，**环境变量优先**（deploy.md §3）。
 * 非法值静默回退内置默认值，保证"配错不炸服务"。
 */
export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd()
  const envFile = options.envFile === undefined ? '.env' : options.envFile
  const fileEnv = envFile === null ? {} : readEnvFile(resolve(cwd, envFile))
  const processEnv = options.env ?? process.env
  return buildAppConfig({ ...fileEnv, ...processEnv })
}

export function createEnvConfigProvider(config: AppConfig): ConfigProvider {
  return { get: () => config }
}
