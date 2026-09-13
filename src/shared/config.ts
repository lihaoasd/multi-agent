/**
 * 平台配置类型与加载。
 *
 * **配置唯一来源 = `.env`（2026-09-13 起；config.yaml 已删除）**：
 * 服务启动时 `process.loadEnvFile()` 加载 `.env`，再由 `configFromEnv()` 解析成配置形状，
 * 最后 `loadConfig()` 填默认值 + 解析相对路径。
 *
 * 命名约定（`.env` 是扁平的 key=value，故用**双下划线表示层级**、**JSON 表示数组**）：
 *   `SERVER__HOST` / `SERVER__PORT` / `DATA_DIR` / `ROLE_DIRS=["...","..."]`
 *   `MODELS__DEFAULT` / `MODELS__PROVIDERS=[{...}]` / `MEETING__ENABLED=false` / `CONTEXT__SESSION__RAW_WINDOW=60`
 * 未设置的键回退到内置默认值（见 DEFAULTS）。密钥仍走同样的环境变量（如 `DEEPSEEK_API_KEY`）。
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

/**
 * 会议段（2026-09-13）：
 *  - `enabled`：**会议功能总开关**。false = 关闭会议：不注册会议工具（角色无法发起/结束）、
 *    会议 REST 全部拒绝（`GET /meetings` 返回空列表）、平台不跑讨论链、前端隐藏会议入口；
 *    **已落盘的会议数据保留**，重新打开即可继续看到。
 *  - autoStart：受邀成员**全部报到**后，平台是否自动开始讨论（主持人开场 → 点名 → 收尾）。
 *    关掉后需由主持人/用户显式推进（测试里常用于只验证"开放/阻塞"等中间态）。
 *  - autoClose：讨论链走完后，平台是否代主持人自动结束会议（生成纪要 + 散会回注）。
 */
export interface MeetingConfig {
  /** 会议功能总开关（缺省视为开启，兼容旧配置） */
  enabled?: boolean
  autoStart: boolean
  autoClose: boolean
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
  meeting: MeetingConfig
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
  meeting?: Partial<MeetingConfig>
  search?: { engine?: 'keyword' | 'vector' }
  context?: {
    session?: Partial<ContextWindowConfig['session']>
    global?: Partial<ContextWindowConfig['global']>
    role?: Partial<ContextWindowConfig['role']>
    search?: Partial<ContextWindowConfig['search']>
    tool?: Partial<ContextWindowConfig['tool']>
  }
}

/** 解析 env 里的布尔：仅 'true'/'1'/'yes' 视为真，'false'/'0'/'no' 视为假，其余 undefined（用默认值）。 */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const v = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return undefined
}

/** 解析 env 里的数字；非法值忽略（用默认值），避免一处笔误让服务起不来。 */
function envNum(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** 解析 env 里的字符串：空串视为未设置。 */
function envStr(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  return v === '' ? undefined : v
}

/** 解析 env 里的 JSON（数组/对象）；非法 JSON 忽略（用默认值）。 */
function envJson<T>(raw: string | undefined): T | undefined {
  const s = envStr(raw)
  if (s === undefined) return undefined
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}

/**
 * `.env`（或任意 env 映射）→ 配置形状。只读取**已设置**的键，未设置的留给 `loadConfig` 填默认值。
 * 纯函数、显式传入 env，便于单测（不依赖真实 `process.env`）。
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigFileShape {
  const shape: ConfigFileShape = {}

  const host = envStr(env.SERVER__HOST)
  const port = envNum(env.SERVER__PORT)
  if (host !== undefined || port !== undefined) {
    shape.server = { ...(host !== undefined ? { host } : {}), ...(port !== undefined ? { port } : {}) }
  }

  const dataDir = envStr(env.DATA_DIR)
  if (dataDir !== undefined) shape.dataDir = dataDir

  const roleDirs = envJson<string[]>(env.ROLE_DIRS)
  if (Array.isArray(roleDirs)) shape.roleDirs = roleDirs.map(String)

  const modelDefault = envStr(env.MODELS__DEFAULT)
  const providers = envJson<ModelsConfig['providers']>(env.MODELS__PROVIDERS)
  if (modelDefault !== undefined || Array.isArray(providers)) {
    shape.models = {
      ...(modelDefault !== undefined ? { default: modelDefault } : {}),
      ...(Array.isArray(providers) ? { providers } : {}),
    }
  }

  const approval: Partial<ApprovalConfig> = {}
  const highRisk = envBool(env.APPROVAL__HIGH_RISK_COMMANDS)
  const docSubmit = envBool(env.APPROVAL__DOC_SUBMIT_APPROVAL)
  const codeSubmit = envBool(env.APPROVAL__CODE_SUBMIT_APPROVAL)
  if (highRisk !== undefined) approval.highRiskCommands = highRisk
  if (docSubmit !== undefined) approval.docSubmitApproval = docSubmit
  if (codeSubmit !== undefined) approval.codeSubmitApproval = codeSubmit
  if (Object.keys(approval).length) shape.approval = approval

  const network = envStr(env.SANDBOX__NETWORK)
  if (network === 'online' || network === 'offline') shape.sandbox = { network }

  const assignByAgent = envBool(env.TASK__ASSIGN_BY_AGENT)
  if (assignByAgent !== undefined) shape.task = { assignByAgent }

  const meeting: Partial<MeetingConfig> = {}
  const meetingEnabled = envBool(env.MEETING__ENABLED)
  const meetingAutoStart = envBool(env.MEETING__AUTO_START)
  const meetingAutoClose = envBool(env.MEETING__AUTO_CLOSE)
  if (meetingEnabled !== undefined) meeting.enabled = meetingEnabled
  if (meetingAutoStart !== undefined) meeting.autoStart = meetingAutoStart
  if (meetingAutoClose !== undefined) meeting.autoClose = meetingAutoClose
  if (Object.keys(meeting).length) shape.meeting = meeting

  const engine = envStr(env.SEARCH__ENGINE)
  if (engine === 'keyword' || engine === 'vector') shape.search = { engine }

  const context: NonNullable<ConfigFileShape['context']> = {}
  const session: Partial<ContextWindowConfig['session']> = {}
  const rawWindow = envNum(env.CONTEXT__SESSION__RAW_WINDOW)
  const maxCharsPerMsg = envNum(env.CONTEXT__SESSION__MAX_CHARS_PER_MSG)
  if (rawWindow !== undefined) session.rawWindow = rawWindow
  if (maxCharsPerMsg !== undefined) session.maxCharsPerMsg = maxCharsPerMsg
  if (Object.keys(session).length) context.session = session
  const globalMax = envNum(env.CONTEXT__GLOBAL__MAX_ENTRIES)
  if (globalMax !== undefined) context.global = { maxEntries: globalMax }
  const roleMax = envNum(env.CONTEXT__ROLE__MAX_ENTRIES)
  if (roleMax !== undefined) context.role = { maxEntries: roleMax }
  const searchMax = envNum(env.CONTEXT__SEARCH__MAX_SNIPPETS)
  if (searchMax !== undefined) context.search = { maxSnippets: searchMax }
  const toolMax = envNum(env.CONTEXT__TOOL__RESULT_MAX_CHARS)
  if (toolMax !== undefined) context.tool = { resultMaxChars: toolMax }
  if (Object.keys(context).length) shape.context = context

  return shape
}

const DEFAULTS: PlatformConfig = {
  server: { host: '127.0.0.1', port: 3000 },
  dataDir: 'data',
  roleDirs: ['src/shared/roles', 'data/roles'],
  models: { default: 'mock', providers: [] },
  approval: { highRiskCommands: true, docSubmitApproval: true, codeSubmitApproval: false },
  sandbox: { network: 'online' },
  task: { assignByAgent: false },
  meeting: { enabled: true, autoStart: true, autoClose: true },
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
    meeting: { ...DEFAULTS.meeting, ...(file.meeting ?? {}) },
    search: { ...DEFAULTS.search, ...(file.search ?? {}) },
    context,
  }
}
