/**
 * 平台配置模型（`docs/design/data-storage.md` §2、`docs/operations/deploy.md` §3）。
 * 本文件是**纯函数**：只做文本解析与取值归一，读文件/读 process.env 属 infra 层。
 * 注意：模型供应商/模型条目/默认路由**不在** `.env`（见 docs/design/model-config.md §11）。
 */

export type SandboxNetwork = 'online' | 'offline'

export interface ServerConfig {
  readonly host: string
  readonly port: number
}

export interface ModelsConfig {
  /** 运行时模型配置文件（UI 维护，UI 改动即时生效） */
  readonly configFile: string
  /** 首次初始化时的默认模型条目 id */
  readonly defaultModelId: string
  /** 是否允许从遗留 MODELS__PROVIDERS 一次性导入 */
  readonly importFromEnv: boolean
  /** 单次模型请求超时上限（毫秒） */
  readonly requestTimeoutMs: number
  /** 提示词长度上限（字符） */
  readonly maxPromptChars: number
}

export interface ApprovalDefaults {
  readonly highRiskCommands: boolean
  readonly docSubmitApproval: boolean
  readonly codeSubmitApproval: boolean
}

export interface SandboxConfig {
  readonly network: SandboxNetwork
}

export interface SearchConfig {
  readonly engine: string
}

export interface ContextLimits {
  readonly session: { readonly rawWindow: number; readonly maxCharsPerMsg: number }
  readonly global: { readonly maxEntries: number }
  readonly role: { readonly maxEntries: number }
  readonly search: { readonly maxSnippets: number }
  readonly tool: { readonly resultMaxChars: number }
}

export interface AppConfig {
  readonly dataDir: string
  readonly roleDirs: readonly string[]
  readonly server: ServerConfig
  readonly models: ModelsConfig
  readonly approval: ApprovalDefaults
  readonly sandbox: SandboxConfig
  readonly search: SearchConfig
  readonly context: ContextLimits
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  dataDir: 'data',
  roleDirs: ['src/shared/roles', 'data/roles'],
  server: { host: '127.0.0.1', port: 3000 },
  models: {
    configFile: 'data/model-config.json',
    defaultModelId: 'mock',
    importFromEnv: true,
    requestTimeoutMs: 60_000,
    maxPromptChars: 20_000,
  },
  approval: { highRiskCommands: true, docSubmitApproval: true, codeSubmitApproval: false },
  sandbox: { network: 'online' },
  search: { engine: 'keyword' },
  context: {
    session: { rawWindow: 60, maxCharsPerMsg: 2000 },
    global: { maxEntries: 12 },
    role: { maxEntries: 12 },
    search: { maxSnippets: 3 },
    tool: { resultMaxChars: 12_000 },
  },
}

type EnvMap = Readonly<Record<string, string | undefined>>

function readString(env: EnvMap, key: string, fallback: string): string {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = raw.trim()
  return value.length > 0 ? value : fallback
}

function readNumber(env: EnvMap, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value < min || value > max) return fallback
  return value
}

function readInteger(env: EnvMap, key: string, fallback: number, min: number, max: number): number {
  const value = readNumber(env, key, fallback, min, max)
  return Number.isInteger(value) ? value : fallback
}

function readBoolean(env: EnvMap, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  return fallback
}

function readStringArray(env: EnvMap, key: string, fallback: readonly string[]): readonly string[] {
  const raw = env[key]
  if (raw === undefined) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const items = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return items.length > 0 ? items : fallback
  } catch {
    return fallback
  }
}

/** 解析 `.env` 文本：忽略注释与空行，去掉同名引号，`export KEY=` 亦可 */
export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const separator = withoutExport.indexOf('=')
    if (separator <= 0) continue
    const key = withoutExport.slice(0, separator).trim()
    if (key.length === 0) continue
    let value = withoutExport.slice(separator + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    result[key] = value
  }
  return result
}

/** 由环境变量合成平台配置：非法值静默回退内置默认值（testing/plan.md §1 shared 层用例） */
export function buildAppConfig(env: EnvMap, defaults: AppConfig = DEFAULT_APP_CONFIG): AppConfig {
  return {
    dataDir: readString(env, 'DATA_DIR', defaults.dataDir),
    roleDirs: readStringArray(env, 'ROLE_DIRS', defaults.roleDirs),
    server: {
      host: readString(env, 'SERVER__HOST', defaults.server.host),
      port: readInteger(env, 'SERVER__PORT', defaults.server.port, 1, 65_535),
    },
    models: {
      configFile: readString(env, 'MODELS__CONFIG_FILE', defaults.models.configFile),
      defaultModelId: readString(env, 'MODELS__DEFAULT', defaults.models.defaultModelId),
      importFromEnv: readBoolean(env, 'MODELS__IMPORT_FROM_ENV', defaults.models.importFromEnv),
      requestTimeoutMs: readInteger(env, 'MODELS__REQUEST_TIMEOUT_MS', defaults.models.requestTimeoutMs, 1_000, 600_000),
      maxPromptChars: readInteger(env, 'MODELS__MAX_PROMPT_CHARS', defaults.models.maxPromptChars, 100, 200_000),
    },
    approval: {
      highRiskCommands: readBoolean(env, 'APPROVAL__HIGH_RISK_COMMANDS', defaults.approval.highRiskCommands),
      docSubmitApproval: readBoolean(env, 'APPROVAL__DOC_SUBMIT_APPROVAL', defaults.approval.docSubmitApproval),
      codeSubmitApproval: readBoolean(env, 'APPROVAL__CODE_SUBMIT_APPROVAL', defaults.approval.codeSubmitApproval),
    },
    sandbox: {
      network:
        readString(env, 'SANDBOX__NETWORK', defaults.sandbox.network) === 'offline' ? 'offline' : 'online',
    },
    search: { engine: readString(env, 'SEARCH__ENGINE', defaults.search.engine) },
    context: {
      session: {
        rawWindow: readInteger(env, 'CONTEXT__SESSION__RAW_WINDOW', defaults.context.session.rawWindow, 1, 10_000),
        maxCharsPerMsg: readInteger(
          env,
          'CONTEXT__SESSION__MAX_CHARS_PER_MSG',
          defaults.context.session.maxCharsPerMsg,
          100,
          1_000_000,
        ),
      },
      global: {
        maxEntries: readInteger(env, 'CONTEXT__GLOBAL__MAX_ENTRIES', defaults.context.global.maxEntries, 0, 1_000),
      },
      role: {
        maxEntries: readInteger(env, 'CONTEXT__ROLE__MAX_ENTRIES', defaults.context.role.maxEntries, 0, 1_000),
      },
      search: {
        maxSnippets: readInteger(env, 'CONTEXT__SEARCH__MAX_SNIPPETS', defaults.context.search.maxSnippets, 0, 100),
      },
      tool: {
        resultMaxChars: readInteger(
          env,
          'CONTEXT__TOOL__RESULT_MAX_CHARS',
          defaults.context.tool.resultMaxChars,
          100,
          10_000_000,
        ),
      },
    },
  }
}
