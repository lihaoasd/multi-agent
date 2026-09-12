/**
 * 平台配置类型与加载。
 * config.yaml 键结构对齐 operations/deploy.md §3；API Key 走环境变量，不入配置。
 */
import { isAbsolute, resolve } from 'node:path'

/** server 段 */
export interface ServerConfig {
  host: string
  port: number
}

/** models 段：默认 provider + 可用 provider 列表 */
export interface ModelProviderConfig {
  id: string
  kind: 'openai-compatible' | 'ollama' | 'mock'
  baseUrl?: string
  apiKeyEnv?: string
  model?: string
  /**
   * completion 预算（默认 8192）。推理型模型的"思考"也吃这个预算：
   * 太小会出现"只出思考、没有正文/工具调用"（角色看起来没干活）→ 按 provider 能力调大。
   */
  maxTokens?: number
}

export interface ModelsConfig {
  default: string
  providers: ModelProviderConfig[]
}

/** approval 段：全局默认审批策略（项目级可覆盖，键名与 project.json 对齐） */
export interface ApprovalConfig {
  highRiskCommands: boolean
  docSubmitApproval: boolean
  codeSubmitApproval: boolean
}

export interface ContextWindowConfig {
  session: { rawWindow: number; maxCharsPerMsg: number }
  global: { maxEntries: number }
  role: { maxEntries: number }
  search: { maxSnippets: number }
  tool: { resultMaxChars: number }
}

export interface PlatformConfig {
  server: ServerConfig
  /** 运行时数据根（相对仓库根解析为绝对路径） */
  dataDir: string
  roleDirs: string[]
  models: ModelsConfig
  approval: ApprovalConfig
  sandbox: { network: 'online' | 'offline' }
  task: { assignByAgent: boolean }
  search: { engine: 'keyword' | 'vector' }
  context: ContextWindowConfig
}

export type ConfigFileShape = {
  server?: Partial<ServerConfig>
  dataDir?: string
  roleDirs?: string[]
  models?: Partial<ModelsConfig>
  approval?: Partial<ApprovalConfig>
  sandbox?: { network?: 'online' | 'offline' }
  task?: { assignByAgent?: boolean }
  search?: { engine?: 'keyword' | 'vector' }
  context?: {
    session?: Partial<ContextWindowConfig['session']>
    global?: Partial<ContextWindowConfig['global']>
    role?: Partial<ContextWindowConfig['role']>
    search?: Partial<ContextWindowConfig['search']>
    tool?: Partial<ContextWindowConfig['tool']>
  }
}

const DEFAULTS: PlatformConfig = {
  server: { host: '127.0.0.1', port: 3000 },
  dataDir: 'data',
  roleDirs: ['src/shared/roles', 'data/roles'],
  models: { default: 'mock', providers: [] },
  approval: { highRiskCommands: true, docSubmitApproval: true, codeSubmitApproval: false },
  sandbox: { network: 'online' },
  task: { assignByAgent: false },
  search: { engine: 'keyword' },
  context: {
    session: { rawWindow: 60, maxCharsPerMsg: 2000 },
    global: { maxEntries: 12 },
    role: { maxEntries: 12 },
    search: { maxSnippets: 3 },
    tool: { resultMaxChars: 12000 },
  },
}

/**
 * 将浅层 config.yaml 文件内容与默认值逐段合并，返回完整配置。
 * providers 为数组：文件有值则整体替换，否则用默认（空）。
 * baseDir 用于把相对路径解析为绝对路径（默认 cwd）。
 */
export function loadConfig(
  file: ConfigFileShape = {},
  baseDir: string = process.cwd(),
): PlatformConfig {
  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p))

  const models: ModelsConfig = {
    default: file.models?.default ?? DEFAULTS.models.default,
    providers: file.models?.providers ?? DEFAULTS.models.providers,
  }
  const approval: ApprovalConfig = {
    ...DEFAULTS.approval,
    ...(file.approval ?? {}),
  }
  const context: ContextWindowConfig = {
    session: { ...DEFAULTS.context.session, ...(file.context?.session ?? {}) },
    global: { ...DEFAULTS.context.global, ...(file.context?.global ?? {}) },
    role: { ...DEFAULTS.context.role, ...(file.context?.role ?? {}) },
    search: { ...DEFAULTS.context.search, ...(file.context?.search ?? {}) },
    tool: { ...DEFAULTS.context.tool, ...(file.context?.tool ?? {}) },
  }

  return {
    server: { ...DEFAULTS.server, ...(file.server ?? {}) },
    dataDir: toAbs(file.dataDir ?? DEFAULTS.dataDir),
    roleDirs: (file.roleDirs ?? DEFAULTS.roleDirs).map(toAbs),
    models,
    approval,
    sandbox: { ...DEFAULTS.sandbox, ...(file.sandbox ?? {}) },
    task: { ...DEFAULTS.task, ...(file.task ?? {}) },
    search: { ...DEFAULTS.search, ...(file.search ?? {}) },
    context,
  }
}
