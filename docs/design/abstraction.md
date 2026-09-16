# 代码抽象设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D18-⑤c（核心端口清单）、D18-⑥（统一策略引擎）、D19（首页三模块/编排/动态配置诉求）、**D20（模型配置与 Agent 配置提交）**、prd §6 可扩展性
> 关联：[architecture.md](architecture.md)（§4 模块树 / §4.1 端口）、[agent-runtime.md](agent-runtime.md)、[model-config.md](model-config.md)（§12 端口落点表）、[orchestration.md](orchestration.md)、[tool-packages.md](tool-packages.md)、[data-storage.md](data-storage.md)、[contract.md](../api/contract.md)、[ui.md](ui.md)
> 本文件是**端口与抽象契约的真源**：architecture.md §4.1 的 7 个端口在此扩展为完整清单，编码阶段以本文件为准。

## 1. 目标与原则

| 目标 | 落地手段 |
| --- | --- |
| **高扩展**：新增工具 / 工具包 / loop 策略 / 模型 provider / 产出物类型 / 场景，不改核心代码 | 注册表（Registry）+ 策略（Strategy）+ 每回合解析的有效配置 |
| **可替换**：文件存储、模型后端、锁、索引、时钟都可换 | 端口（Port）+ 适配器（Adapter），跨层只走接口 |
| **可测**：领域逻辑零 IO、外部依赖可替身 | domain/ports 不依赖 node API；每端口配 InMemory 替身与契约测试 |
| **用户可动态配置**（U9 三项已定案 D20-⑧，工具挂载仍待定） | 运行时改**模型/loop/提示词**（模型配置范围见 model-config.md）与后续的工具挂载，**不重建容器、不重启** | 依赖注入只注入稳定能力；实例配置作为 `TurnContext` **参数**传递；工具与 loop 运行期查表 |
| **简单可靠**：单进程、纯文件系统、零重型依赖 | 自研轻量容器；不引装饰器/反射库；不引 ORM/DB |

设计原则（写进 code review 清单）：

1. **依赖只向内**：外层知道内层，内层不知道外层；`domain` 不认识 HTTP/WS/文件系统。
2. **配置与能力分离**：能力（端口/注册表）由容器注入；配置（实例 tools/loop/model）每回合解析后传参。
3. **扩展点在注册表，不在分支**：加能力 = 注册一个实现，不是改一串 `if/else`。
4. **错误显式**：领域/应用层返回 `Result<T>`；异常只用于编程错误与外部边界（见 §9）。
5. **纯函数优先**：状态机、规则、路径判定、编排校验都是纯函数（输入→输出，无副作用）。
6. **副作用集中在适配器**：IO、时间、随机、子进程、网络只在 `infra/`（便于测试与审计）。

## 2. 分层与依赖规则

```
        ┌───────────────┐
        │  bootstrap    │  组合根：装配容器、注册表、订阅、启动自检
        └──────┬────────┘
   ┌───────────┴───────────┐
   │                       │
┌──▼────────┐        ┌─────▼─────┐
│  server   │        │   infra   │   适配器：HTTP/WS、文件、模型、工具、沙箱、锁
└──┬────────┘        └─────┬─────┘
   │        ┌──────────────┘
   │        │
┌──▼────────▼──┐
│ application  │  用例编排：服务 + 端口调用 + 事务/锁边界
└──┬───────────┘
   │
┌──▼────────┐    ┌────────┐    ┌────────┐
│  domain   │───▶│ ports  │◀───│ shared │
└───────────┘    └────────┘    └────────┘
```

| 层 | 可以依赖 | 禁止依赖 | 典型内容 |
| --- | --- | --- | --- |
| `shared` | — | 其余全部 | `Result`、错误码、ID/时间工具、配置模型、日志接口 |
| `ports` | `shared` | domain/application/infra/server | 端口接口 + DTO（**只有类型，没有实现**） |
| `domain` | `shared`、`ports`(仅类型) | application/infra/server、`node:*` | 聚合与实体、状态机、规则纯函数、领域事件定义 |
| `application` | `domain`、`ports`、`shared` | infra/server、`node:*` | 服务（session/task/question/approval/artifact/orchestration/agent-loop） |
| `infra` | `ports`、`domain`、`shared`、`node:*` | application/server | file-store、indexer、model providers、tools、sandbox、lock、packages |
| `server` | `application`、`ports`、`shared` | infra（静态资源也走端口）、domain 直接调用 | http-routes、ws 网关、静态资源端口 |
| `bootstrap` | 全部 | — | composition-root、启动自检、进程信号 |

**门禁**（eslint `no-restricted-imports` zones + ratchet，CI 失败条件）：

- 新增依赖违规即失败，历史违规计数只减不增；
- `domain/`、`ports/` 中出现 `from 'node:` / `fs` / `http` 直接失败；
- `application/` 中出现 `infra` 路径失败（必须改为依赖端口）；
- 端口接口方法不得暴露 `infra` 类型（DTO 定义在 `ports/dto.ts`）。

## 3. 领域模型

### 3.1 聚合与实体

| 聚合根 | 实体/值对象 | 关键不变式 | 所属 |
| --- | --- | --- | --- |
| `Project` | `RoleInstance`、`ProjectPolicy`、`WorkdirRef` | 每模板至多 1 实例；实例 `enabled=false` 不领活；workdir 必须存在且可写 | domain/models/project.ts |
| `OrchestrationGraph` | `GraphNode`、`GraphEdge` | 无自环、无重复边、节点必须属于本项目实例 | domain/models/orchestration.ts |
| `Session` | `Event`（append-only 流）、`SummaryRef`、`SegmentRef` | seq 会话内单调连续；`turn_start`/`turn_end` 成对；流式文本只落完整消息 | domain/models/session.ts |
| `Task` | `TaskState`、`TaskOrigin`(creator/edge) | 每 Agent 至多 1 个 `in_progress`；`terminated` 前先结算改动快照 | domain/models/task.ts |
| `Question` | `QuestionItem`、`Answer` | 同一 Agent 至多 1 个 `pending` | domain/models/question.ts |
| `Approval` | `ApprovalDecision` | 决定只能落一次（`pending → approved/rejected/expired`） | domain/models/approval.ts |
| `Artifact` | `ArtifactFile`、`VersionRef` | 版本号单调；回退生成新版本而非删历史 | domain/models/artifact.ts |
| 「文件归属」 | `FileOwner` | 非 owner 写入必须被拒；无主文件首写认领 | domain/models/file-owner.ts |
| `Turn`（运行期） | `TurnContext`、`PlanState` | 单工：至多一个活动会话；暂停只在可中断点 | domain/models/turn.ts |

### 3.2 状态机（纯函数）

```
domain/fsm/agent.ts     idle → working → (waiting) → idle      // 三态 + paused 开关
domain/fsm/session.ts   active ⇄ suspended → archived
domain/fsm/task.ts      todo → in_progress → done|blocked|terminated
domain/fsm/approval.ts  pending → approved|rejected|expired
domain/fsm/question.ts  pending → answered
```

- 统一形态：`transition<S, E>(state: S, event: E): Result<S>`，非法流转返回 `ERR_CONFLICT`；
- 状态机**不含 IO**，可直接单测（`testing/plan.md` 规则 1/8/24 覆盖）；
- 谁保证哪条不变式：**纯规则由 domain 保证**（编排边校验、审批优先级、归属判定）；**跨聚合与并发由 application + `LockManager` 保证**（任务槽位、注册表写入、manifest 更新）。

### 3.3 领域事件

事件是**唯一真相的投影源**（D18-⑤d）：`domain/events/index.ts` 定义判别联合 `DomainEvent`（`kind + payload + scope`），会话 log、WS 推送、索引、摘要、列表刷新都是它的投影。新增事件必须在此登记，禁止旁路词汇。

## 4. 端口清单

命名约定：文件 `ports/<域>.ts`，接口 `XxxStore` / `XxxGateway` / `XxxRegistry`；方法一律 `Promise`（IO 端口）或同步（纯函数端口）。

### 4.1 存储类

| 端口 | 职责 | 默认适配器 | 测试替身 |
| --- | --- | --- | --- |
| `ProjectStore` | 项目 CRUD + `project.json` 读写 | infra/file-store | InMemoryProjectStore |
| `RoleTemplateStore` | 模板列表/读取/复制新建/编辑/停用/**删除用户模板**/**设置默认模型**（内置的停用与默认模型写数据目录覆盖） | infra/file-store（内置 yaml 只读 + data/roles + `agent-templates-state.json`） | 固定模板集 |
| `SessionLogStore` | 会话事件追加（分配 seq）、窗口读取、轮转 | infra/file-store | InMemoryLogStore |
| `SessionMetaStore` | 会话 meta 读写（状态/分段/摘要引用） | infra/file-store | InMemoryMetaStore |
| `MemoryStore` | L3 条目（global/角色）读写与检索 | infra/file-store | InMemoryMemoryStore |
| `TaskStore` | 任务 CRUD + 槽位约束读写 | infra/file-store | InMemoryTaskStore |
| `QuestionStore` | 询问创建/答复/待答查询 | infra/file-store | InMemoryQuestionStore |
| `ApprovalStore` | 审批请求/决定/历史 | infra/file-store | InMemoryApprovalStore |
| `ArtifactStore` | 产出物 manifest、版本目录、归属表 | infra/file-store | InMemoryArtifactStore |
| `OrchestrationStore` | 编排图读取/全量保存（乐观并发） | infra/file-store | InMemoryOrchestrationStore |
| `DispatcherStateStore` | occupancy 与 `lastHandledSeq`（运行期态） | infra/file-store | InMemoryStateStore |
| `SearchIndex` | 倒排索引构建/增量/查询/重建 | infra/indexer | 直读实现（小数据） |

### 4.2 模型类

| 端口 | 职责 | 默认适配器 |
| --- | --- | --- |
| `ModelConfigStore` | 平台模型配置（`data/model-config.json`）读取/原子写 + `revision` 乐观并发 + 配置审计追加 | infra/file-store |
| `ProviderKindAdapter` | **单个协议适配**：`stream` / `listModels?` / `test?` / `capabilities`（由原 `ModelProvider` 更名，避免与"用户配置的供应商"混淆） | infra/model/providers（`openai-compatible`/`anthropic`/`gemini`/`ollama`） |
| `ProviderKindRegistry` | `kind → 适配器` 注册与解析（由原 `ProviderRegistry` 更名） | infra/model |
| `ModelCatalog` | `modelId → {provider, credential, model 名, params, kind}` 解析 + `revision` 缓存 + `invalidate()` | application/model-config |
| `ModelGateway` | 按**模型条目 id** 路由到适配器，统一流式输出，外挂脱敏装饰 | infra/model |

### 4.3 执行类

| 端口 | 职责 | 默认适配器 |
| --- | --- | --- |
| `ToolRegistry` | 工具注册/查询（按 name、package、会话类型） | infra/tools |
| `ToolExecutor` | 校验链 → 审批桥 → 执行 → 审计 → 归属校验 | infra/tools |
| `ToolPackageRegistry` | 工具包元数据（7 个基础包）与挂载解析 | infra/tools |
| `CmdRunner` | 结构化 argv 子进程执行（超时/杀掉进程树/输出截断） | infra/sandbox |
| `FileStore` | 原子读写、JSONL 追加、目录列举、watch | infra/file-store |
| `LockManager` | KeyedLock（按项目/文件/会话串行化）+ 进程内互斥 | infra/lock |

### 4.4 策略类（纯函数端口）

| 端口 | 职责 | 默认实现 |
| --- | --- | --- |
| `PolicyEngine` | `(actor, sessionType, tool/command, params, projectPolicy, trust)` → `allow/approval/deny` + `ruleId`，优先级 `deny > approval > allow` | domain/rules/policy |
| `PathResolver` | 虚拟路径（`workdir://`、`ro://`、`runtime://`）解析 + 边界校验 | infra/sandbox（纯函数部分在 domain/rules/path） |
| `OwnershipPolicy` | 文件归属判定（无主/自己/他人 → allow/deny） | domain/rules/ownership |
| `DelegationPolicy` | 编排边委派判定（出边才可派，汇报沿反向） | domain/rules/orchestration |
| `VisibilityPolicy` | 记忆/会话检索可见性（D18-②） | domain/rules/visibility |
| `EffectiveAgentConfigResolver` | 模板 → 实例 → 项目 → 平台默认 的**有效配置**解析（带失效缓存） | application/team |

### 4.5 平台类

| 端口 | 职责 | 默认适配器 |
| --- | --- | --- |
| `Container` | DI 容器（§5） | bootstrap/container |
| `EventBus` | 领域事件发布/订阅（进程内，先盘后推） | infra/events |
| `Clock` | 当前时间（可注入固定时钟） | infra/util/system-clock |
| `IdGenerator` | 各类 id 生成（可注入确定性 id） | infra/util/id |
| `Logger` | 结构化日志（含审计通道） | infra/util/logger |
| `ConfigProvider` | `.env` 加载 + 默认值 + 类型校验 | shared/config + infra/config |
| `StaticAssetProvider` | 前端静态资源（server 不直接读盘） | infra/static |

### 4.6 核心接口签名（编码阶段照此实现）

```ts
// ── shared/result.ts ──────────────────────────────────────────────
export interface AppError { code: ErrorCode; message: string; detail?: Record<string, unknown> }
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }
export declare function ok<T>(value: T): Result<T>
export declare function err(code: ErrorCode, message: string, detail?: Record<string, unknown>): Result<never>

// ── ports/session-log.ts ──────────────────────────────────────────
export interface NewEvent { kind: EventKind; turn: number; payload: EventPayload; ts?: string }
export interface StoredEvent extends NewEvent { seq: number; ts: string; sessionId: SessionId }

export interface SessionLogStore {
  /** 追加事件并分配连续 seq（原子；先落盘后由调用方 publish） */
  append(sessionId: SessionId, events: NewEvent[]): Promise<Result<StoredEvent[]>>
  /** 按 seq 窗口读取（重连/恢复）；limit 为尾窗条数 */
  readWindow(sessionId: SessionId, opts?: { fromSeq?: number; limit?: number }): Promise<Result<StoredEvent[]>>
  /** 按 kind 过滤（原始事件时间线视图） */
  readKinds(sessionId: SessionId, kinds: EventKind[], opts?: { fromSeq?: number; limit?: number }): Promise<Result<StoredEvent[]>>
  lastSeq(sessionId: SessionId): Promise<number>
  /** 超阈值轮转；返回分段表（seq 跨段仍单调） */
  rotate(sessionId: SessionId, maxLines: number): Promise<Result<SegmentRef[]>>
}
// ⚠️ 实现口径（2026-09-15，S3）：会话文件位于 `projects/<pid>/sessions/` 内，故实现把 `projectId`
//    作为**第一个参数**（`append(projectId, sessionId, events)` 等），避免为定位文件而全盘扫描项目目录。
//    同时 `FileStore` 增加 `move(from, to)`（日志轮转需要原子改名）。签名以本节注释为准。

// ── ports/file-store.ts ───────────────────────────────────────────
export interface FileStore {
  readText(path: RelPath): Promise<Result<string>>
  readJson<T>(path: RelPath): Promise<Result<T>>
  /** 写临时文件 + rename；expectedHash 用于乐观并发（他人已改则 ERR_CONFLICT） */
  writeAtomic(path: RelPath, content: string, opts?: { expectedHash?: string }): Promise<Result<WriteReceipt>>
  writeJsonAtomic<T>(path: RelPath, value: T): Promise<Result<WriteReceipt>>
  appendLine(path: RelPath, line: string): Promise<Result<void>>
  list(dir: RelPath): Promise<Result<DirEntry[]>>
  stat(path: RelPath): Promise<FileStat | null>
  watch(dir: RelPath, cb: (change: FsChange) => void): Disposer
}

// ── ports/tools.ts ────────────────────────────────────────────────
export interface ToolDefinition {
  name: ToolName; package: PackageId; description: string
  paramsSchema: JsonSchema; scope: 'workdir' | 'readonly-global' | 'platform'
  risk: 'none' | 'low' | 'high'; network: 'none' | 'allowed' | 'outbound_high'
  needsApproval?: RuleRef; idempotent: boolean; timeoutMs?: number
  availableIn: SessionType[]; allowedRoots: RootScheme[]
  output: { maxChars: number; strategy: 'truncate-tail' | 'summarize' | 'raw' }
}
export type ToolHandler = (input: ToolInput, ctx: ToolCallContext) => Promise<ToolOutcome>

export interface ToolRegistry {
  register(def: ToolDefinition, handler: ToolHandler): void
  get(name: ToolName): { def: ToolDefinition; handler: ToolHandler } | undefined
  list(filter?: { package?: PackageId; availableIn?: SessionType }): ToolDefinition[]
}

/** 校验链：注册→白名单→会话类型→策略→边界→归属→审批桥→执行→审计（失败结构化回注 Agent） */
export interface ToolExecutor {
  execute(call: ToolCall, ctx: TurnContext): Promise<Result<ToolOutcome>>
}

// ── ports/model.ts ────────────────────────────────────────────────
export interface ModelRequest {
  model: ModelId; messages: ChatMessage[]; tools?: ToolSchema[]   // ModelId = 模型条目 id（D20-①），不再是 provider id
  temperature?: number; maxTokens?: number; signal: AbortSignal
}
export type ModelChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: ToolName; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }

export interface ModelGateway {
  /** 统一流式：provider 差异在此归一化；失败返回 ERR_MODEL（错误事件回注，detail 已脱敏） */
  stream(req: ModelRequest): AsyncIterable<ModelChunk>
  listModels(): ModelInfo[]
}

// ── ports/model-config.ts（D20，schema 见 model-config.md §3~§4）────
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'
export type Credential =
  | { mode: 'file'; value: string }               // 存 data/model-config.json（data/ 不入库）
  | { mode: 'env'; envName: string }              // 只存变量名
export interface ModelProviderConfig {
  id: ProviderId; name: string; kind: ProviderKind; baseUrl: string
  credential: Credential; headers?: Record<string, string>
  enabled: boolean; timeoutMs?: number; presetId?: string | null
}
export interface ModelEntry {
  id: ModelId; providerId: ProviderId; model: string; displayName: string
  capabilities: Array<'chat' | 'stream' | 'tools' | 'reasoning'>
  contextWindow?: number; maxOutputTokens?: number
  defaultParams?: { temperature?: number; maxTokens?: number }
  enabled: boolean
}
export interface ModelRouting {
  defaultModelId: ModelId
  stepOverrides?: Partial<Record<LoopStepName, ModelId>>
}
export interface ModelConfigSnapshot {
  schemaVersion: 1; revision: number
  providers: ModelProviderConfig[]; models: ModelEntry[]; routing: ModelRouting
}
export interface ModelConfigStore {
  load(): Promise<Result<ModelConfigSnapshot>>
  /** 原子写 + revision 乐观并发（expectedRevision 不符 → ERR_CONFLICT） */
  save(next: ModelConfigSnapshot, expectedRevision: number): Promise<Result<ModelConfigSnapshot>>
  appendAudit(entry: ConfigAuditEntry): Promise<Result<void>>   // 不含密钥明文/提示词全文
}
/** 单个协议适配：kind 差异只在这里；失败语义 ERR_MODEL */
export interface ProviderKindAdapter {
  readonly kind: ProviderKind
  readonly capabilities: { stream: boolean; tools: boolean; reasoning: boolean }
  stream(provider: ModelProviderConfig, entry: ModelEntry, req: ModelRequest): AsyncIterable<ModelChunk>
  listModels?(provider: ModelProviderConfig): Promise<Result<string[]>>
  test?(provider: ModelProviderConfig, opts: { mode: 'models' | 'chat'; entry?: ModelEntry }): Promise<Result<{ latencyMs: number; models?: string[] }>>
}
export interface ProviderKindRegistry {
  register(adapter: ProviderKindAdapter): void
  get(kind: ProviderKind): ProviderKindAdapter | undefined
  list(): ProviderKind[]
}
/** modelId → 解析结果（带 revision 缓存与失效）；凭证只在此内部流转，不进日志 */
export interface ModelCatalog {
  resolve(modelId: ModelId): Promise<Result<ResolvedModel>>
  invalidate(): void
}

// ── ports/policy.ts ───────────────────────────────────────────────
export interface PolicyInput {
  actor: Actor; sessionType: SessionType
  action: { kind: 'tool'; tool: ToolName; params: unknown } | { kind: 'command'; program: string; args: string[] }
  projectPolicy: ProjectPolicy; trust?: TrustScope
}
export interface PolicyDecision { decision: 'allow' | 'approval' | 'deny'; ruleId: string; reason: string }
export interface PolicyEngine { decide(input: PolicyInput): PolicyDecision }

// ── ports/orchestration.ts ────────────────────────────────────────
export interface OrchestrationGraph {
  schemaVersion: 1; projectId: ProjectId; version: number; updatedAt: string
  nodes: GraphNode[]; edges: GraphEdge[]
}
export interface OrchestrationStore {
  load(projectId: ProjectId): Promise<Result<OrchestrationGraph>>
  /** 全量保存 + 乐观并发（expectedVersion 不符 → ERR_CONFLICT）；校验失败 → ERR_ORCHESTRATION_INVALID */
  save(projectId: ProjectId, graph: OrchestrationGraph, expectedVersion: number): Promise<Result<OrchestrationGraph>>
}

// ── ports/turn.ts（每回合上下文：实例级配置以参数出现，不进容器）────────
export interface EffectiveAgentConfig {
  instanceId: InstanceId
  systemPrompt: string
  loop: { strategy: LoopStrategyName; params: LoopParams }
  packages: PackageId[]
  tools: ToolName[]
  model: ModelId                       // 模型条目 id（D20-①）
  approvalRules: RuleRef[]
}
export interface TurnContext {
  readonly turnId: TurnId
  readonly project: ProjectRef
  readonly instance: InstanceRef
  readonly sessionId: SessionId
  readonly config: EffectiveAgentConfig
  readonly scope: Container
  readonly signal: AbortSignal
  readonly now: Date
}

// ── ports/loop.ts（策略扩展点：用户自定义 loop 就注册到这里）──────────
export interface AgentLoopStrategy {
  readonly name: LoopStrategyName
  run(ctx: TurnContext, deps: LoopDeps): AsyncIterable<TurnEvent>
}
export interface LoopRegistry {
  register(strategy: AgentLoopStrategy): void
  get(name: LoopStrategyName): AgentLoopStrategy | undefined
  list(): LoopStrategyName[]
}

// ── ports/events.ts ───────────────────────────────────────────────
export interface EventBus {
  publish(event: DomainEvent): Promise<void>
  subscribe(kinds: DomainEvent['kind'][], handler: (e: DomainEvent) => void | Promise<void>): Disposer
}
```

## 5. 依赖注入设计

### 5.1 为什么自研轻量容器（不引 awilix/tsyringe/InversifyJS）

| 维度 | 自研（~100 行） | 装饰器式容器 |
| --- | --- | --- |
| 依赖 | 零 | 需 `reflect-metadata` + `experimentalDecorators`，与"不引重型依赖"相悖 |
| 可读性 | 装配集中在一个组合根，导入即见 | 依赖藏在装饰器里，跳转靠工具 |
| 类型 | `Token<T>` 泛型推导，`resolve` 有类型 | 常见 `any` 或反射推断 |
| 动态性 | 注册表 + 每回合解析（§5.5）天然支持运行时变化 | 容器多为启动期静态图，动态改配置易被塞进构造函数 |
| 风险 | 需自己保证作用域与释放 | 生态成熟 |

结论：**自研轻量容器**；若将来出现复杂生命周期需求，只需替换 `Container` 接口实现，调用方无感（这正是端口化的收益）。

### 5.2 容器接口与 Token

```ts
export interface Token<T> { readonly key: string; readonly __type?: T }
export function token<T>(key: string): Token<T> { return { key } as Token<T> }

export type Lifetime = 'singleton' | 'scoped' | 'transient'

export interface Container {
  register<T>(t: Token<T>, factory: (c: Container) => T, opts?: { lifetime?: Lifetime }): void
  registerInstance<T>(t: Token<T>, value: T): void
  resolve<T>(t: Token<T>): T                       // 未注册 → 抛 ERR_INTERNAL（编程错误）
  tryResolve<T>(t: Token<T>): T | undefined
  createScope(): Container                          // per-turn / per-request 作用域
  has<T>(t: Token<T>): boolean
  dispose(): Promise<void>                          // 逆序释放（watch、子进程、锁）
}
```

- Token 只定义一次（`ports/tokens.ts`），键名与接口名一致（`token<SessionLogStore>('SessionLogStore')`）；
- **构造器注入**：服务写法统一为 `constructor(private readonly deps: {...})`，不用属性注入、不用服务定位器（见 §6 反模式）；
- 未注册依赖在**启动期**暴露：组合根最后执行 `container.assertGraph([...必需 Token])`，缺一即启动失败。

### 5.3 生命周期

| 生命周期 | 用于 | 示例 |
| --- | --- | --- |
| `singleton` | 无状态/有长生命周期资源的适配器与注册表 | `FileStore`、`LockManager`、`EventBus`、各 `*Registry`、`ModelGateway`、`PolicyEngine` |
| `scoped` | 一次回合/一次请求内共享的对象 | `TurnContext`、`EffectiveAgentConfig` 快照、审批上下文、事务/锁句柄 |
| `transient` | 轻量纯函数服务 | 上下文组装器、摘要构建器、校验链节点 |

约定：**长生命周期对象不得持有 scoped 对象**（否则内存泄漏 + 语义错误）；`EventBus` 的订阅者在 `dispose` 时注销。

### 5.4 组合根（唯一装配处）

`src/bootstrap/composition-root.ts`——对齐 architecture.md §4.1 的装载顺序：

```ts
export async function buildContainer(env: Env): Promise<Container> {
  const c = createContainer()
  // 1) 平台
  c.registerInstance(TOKENS.Clock, systemClock); c.registerInstance(TOKENS.Logger, createLogger(env))
  c.registerInstance(TOKENS.Config, loadConfig(env))
  // 2) 存储与锁
  c.register(TOKENS.FileStore, () => new FileStoreAdapter(c.resolve(TOKENS.PathResolver)), { lifetime: 'singleton' })
  c.register(TOKENS.SessionLogStore, () => new FileSessionLogStore(c.resolve(TOKENS.FileStore)), { lifetime: 'singleton' })
  c.register(TOKENS.LockManager, () => new KeyedLockManager(), { lifetime: 'singleton' })
  // 3) 策略（纯函数）
  c.register(TOKENS.PolicyEngine, () => createPolicyEngine({ rules: builtinRules }), { lifetime: 'singleton' })
  c.register(TOKENS.PathResolver, () => createPathResolver(c.resolve(TOKENS.Config)), { lifetime: 'singleton' })
  // 4) 模型（D20：协议 kind 注册表 + 平台模型配置 + 目录解析）
  c.register(TOKENS.ModelConfigStore, () => new FileModelConfigStore(c.resolve(TOKENS.FileStore)), { lifetime: 'singleton' })
  c.register(TOKENS.ModelCatalog, () => new ModelCatalog(c.resolve(TOKENS.ModelConfigStore)), { lifetime: 'singleton' })
  registerBuiltinProviderKinds(c.resolve(TOKENS.ProviderKindRegistry))
  c.register(TOKENS.ModelGateway, () => createModelGateway({ kinds: c.resolve(TOKENS.ProviderKindRegistry), catalog: c.resolve(TOKENS.ModelCatalog) }), { lifetime: 'singleton' })
  // 5) 注册表（扩展点集中登记）
  registerBuiltinTools(c.resolve(TOKENS.ToolRegistry), { deps: c })
  registerBuiltinPackages(c.resolve(TOKENS.ToolPackageRegistry))
  registerBuiltinLoops(c.resolve(TOKENS.LoopRegistry))
  registerBuiltinArtifactTypes(c.resolve(TOKENS.ArtifactTypeRegistry))
  // 6) 应用服务
  c.register(TOKENS.Dispatcher, () => new Dispatcher(c.resolve(TOKENS.DispatcherStateStore), /* … */), { lifetime: 'singleton' })
  c.register(TOKENS.AgentLoopService, () => new AgentLoopService(/* … */), { lifetime: 'singleton' })
  // 7) 事件订阅（投影：WS 推送、索引、摘要、列表刷新）
  wireEventProjections(c)
  container.assertGraph(REQUIRED_TOKENS)   // 启动自检：缺依赖立即失败
  return c
}
```

测试用 `tests/helpers-server.ts`：与生产同一条 `buildContainer` → `resolveDeps` 装配路径，只把 `gateway`/`broadcaster` 等换成替身并可注入 `envMap`；**测试与生产装配只差一个注入点**，这是可测性的关键。

### 5.5 动态配置：用户改实例工具/loop 为什么不重建容器

三条硬约束：

1. **容器只注入稳定能力**：端口、注册表、解析器、锁、时钟。**永远不把**"某实例允许的工具列表""某实例的 loop 策略对象"注入构造函数。
2. **实例配置每回合解析**：`EffectiveAgentConfigResolver.resolve(projectId, instanceId)` 按 `实例覆盖 → 模板快照 → 平台默认` 合成 `EffectiveAgentConfig`（真源：`src/application/team/effective-config.ts`；S11 的"未配置 Agent 统计"用同一函数），作为 `TurnContext.config` 传给用例；解析结果按 `(projectId, instanceId, configVersion)` 缓存。
3. **按 id 运行期查表**：工具通过 `ToolRegistry.get(name)`、loop 通过 `LoopRegistry.get(strategy)` 在**回合开始时**解析；因此新增/替换实现只需 `register`。

时序（用户改配置 → 生效）：

```
用户改实例 提示词 / loop / 模型（D20-⑧；工具挂载仍待定 U9）
  → 写入实例配置 + configVersion+1（审计）
  → EffectiveAgentConfigResolver.invalidate(projectId, instanceId)
  → 该 Agent 下一个回合开始时重新解析 → TurnContext.config 为新值
  → 运行中的回合：到可中断点后生效（不打断当前工具调用）
  → 容器 / 注册表 / 进程：均不变（无需重启）

用户改平台模型配置（供应商 / 模型条目 / 默认路由，D20-⑤）
  → 原子写 data/model-config.json + revision+1（审计）
  → ModelCatalog.invalidate()
  → 下一次模型调用即用新配置（进行中的流式请求不中断）
  → 容器 / 注册表 / 进程：均不变（无需重启）
```

| 用户动作 | 生效机制 | 需重建容器？ | 需重启？ |
| --- | --- | --- | --- |
| 改实例 loop 策略/参数 | 下回合解析 + `LoopRegistry.get` | 否 | 否 |
| 改实例/模板 提示词 | 下回合解析 `EffectiveAgentConfig.systemPrompt` | 否 | 否 |
| 挂载/取消工具包 | 下回合重算 `tools` 白名单 | 否 | 否 |
| 新增自定义工具包（U8） | `ToolPackageRegistry.register` + `ToolRegistry.register` | 否 | 否 |
| 新增 loop 策略 | `LoopRegistry.register` | 否 | 否 |
| **新增/编辑供应商或模型条目**（D20） | 原子写 `model-config.json` → `ModelCatalog.invalidate()`（`revision` 变化） | 否 | 否 |
| **新增一种协议 kind** | 实现 `ProviderKindAdapter` + `ProviderKindRegistry.register`（组合根一行的注册） | 否 | 否 |
| 改全局默认路由 | 下回合 `EffectiveAgentConfigResolver` 重新解析 | 否 | 否 |
| 单个 Agent 暂停/恢复 | dispatcher 运行期态（不入容器） | 否 | 否 |
| 换存储后端/换锁实现 | 换端口实现 | **是**（启动期） | 是 |
| 改平台 `.env` 配置（含 `MODELS__CONFIG_FILE`/超时上限） | 启动期读取 | 是 | 是 |

## 6. 设计模式清单

| 模式 | 用在哪 | 解决什么 | 落点 |
| --- | --- | --- | --- |
| Ports & Adapters（六边形） | 全部跨层交互 | 存储/模型/执行可替换、可替身 | `ports/` + `infra/` |
| Composition Root + DI | 进程启动 | 依赖集中装配、启动期暴露缺失依赖 | `bootstrap/composition-root.ts` |
| Strategy | loop 策略、产出物类型 diff、检索提供者 | 新增策略不改调度代码 | `LoopRegistry`、`ArtifactTypeRegistry`、`SearchProvider` |
| Registry | 工具、工具包、**协议 kind**、loop、产出物类型、场景 | "注册即扩展"，避免 if/else | `infra/*/registry.ts` |
| Repository | 每个 `*Store` | 隔离文件布局与用例逻辑 | `infra/file-store/*` |
| Unit of Work + KeyedLock | 任务槽位、manifest、归属表、编排图保存 | 串行化读改写、避免丢更新 | `infra/lock` + `application/*` |
| Observer / Pub-Sub | `EventBus` → WS、索引、摘要、列表刷新 | 一个事件多处投影，解耦 | `infra/events` |
| Chain of Responsibility | 工具校验链、审批规则链、上下文组装段 | 可插拔校验，顺序明确 | `application/tools/validation-chain.ts`、`domain/rules/policy.ts` |
| Decorator | 审计、重试、计时、脱敏包裹 `ToolExecutor`/`ModelGateway` | 横切关注点不污染实现 | `infra/tools/decorators.ts` |
| Command | `ToolCall` 封装（幂等/审批/可重放） | 调用语义统一、可审计可重试 | `domain/models/tool-call.ts` |
| Builder | 上下文组装、系统提示拼装 | 分段可测、可预览（Agent 模块的提示词预览复用同一 Builder） | `application/agent-loop/context-builder.ts` |
| State（表驱动） | Agent/会话/任务/审批/询问状态机 | 非法流转统一拒绝、易测 | `domain/fsm/*` |
| Template Method | 回合执行骨架（组装→模型→工具→落盘→记忆） | 各 loop 只覆写步骤编排 | `application/agent-loop/runner.ts` |
| Policy | 审批/归属/可见性/委派 | 规则集中、优先级明确 | `domain/rules/*` |
| Snapshot / Memento | 产出物版本与回退 | 可回退且不删历史 | `infra/file-store/artifact-versions` |
| Result | 所有跨层返回 | 错误显式、与 REST/工具协议对齐 | `shared/result.ts` |

**反模式（禁止）**：

1. **服务定位器滥用**：业务代码里到处 `container.resolve(...)`——依赖必须由构造器传入；容器只出现在组合根与 `TurnContext.scope` 的显式入口。
2. **万能事件总线承载业务逻辑**：事件只做**投影**（推送/索引/摘要），业务决策仍走用例函数；不得用"发个事件然后某处改状态"替代显式调用。
3. **过早泛型仓储**：不要 `Repository<T, ID>`，每个聚合一个明确的 `*Store` 端口（字段差异大，泛型只会变成 `any`）。
4. **把配置当依赖**：见 §5.5 约束 1。
5. **domain 里 import fs/http**：门禁直接拦截。

## 7. 扩展点操作手册

| 要做的事 | 步骤 | 需要动容器吗 |
| --- | --- | --- |
| **新增工具** | ① `domain/models/tool.ts` 补类型；② `infra/tools/builtin/<name>.ts` 写 `ToolDefinition` + `ToolHandler`；③ 在 `registerBuiltinTools` 登记；④ 视需要加入工具包与角色矩阵；⑤ 补测试（校验链 + 审计） | 否（`register` 即可） |
| **新增工具包** | ① `src/shared/tool-packages/<id>.yaml` 加包元数据；② 工具侧 `package` 指到该 id；③ 启动自检校验包内一致 | 否 |
| **新增 loop 策略** | ① 实现 `AgentLoopStrategy`；② `registerBuiltinLoops` 登记；③ 角色模板 `defaultLoop.strategy` 可引用 | 否 |
| **新增协议 kind** | ① 实现 `ProviderKindAdapter`（`stream`/可选 `listModels`/`test`）；② 组合根 `ProviderKindRegistry.register`；③ `shared/model-presets.yaml` 加预置条目（可选） | 否 |
| **新增一家预置供应商** | ① `src/shared/model-presets.yaml` 加条目（`presetId/name/kind/baseUrl/credentialHint/suggestedModels`，**不含密钥**）；② 若 kind 已存在则无需改代码 | 否 |
| **新增产出物类型** | ① 注册类型（默认路径/校验/diff 器）；② 更新落盘布局规则 | 否 |
| **新增场景（U10）** | ① 模板 YAML 加 `scenario: general`；② 首页筛选自动生效 | 否 |
| **新增 WS 事件** | ① `domain/events` 登记 kind；② `contract.md` 补下行映射；③ 在投影装配里订阅 | 否 |
| **换存储后端** | 实现同一 `*Store` 端口并在组合根改绑定 | **是** |
| **新增 REST 端点** | ① `application` 加用例（返回 `Result`）；② `server/http-routes` 暴露（错误映射统一中间件） | 否 |

## 8. 目标目录结构

```
src/
├── shared/                 # Result/错误码/ID/时钟接口/配置模型/JSON 工具
├── ports/                  # 端口契约 + DTO + tokens.ts（只依赖 shared）
├── domain/
│   ├── models/             # 聚合与实体（Project/Session/Task/Question/Approval/Artifact/Orchestration…）
│   ├── fsm/                # 状态机纯函数
│   ├── rules/              # policy/ownership/delegation/visibility/path 纯规则
│   └── events/             # DomainEvent 判别联合
├── application/
│   ├── project/ team/ session/ task/ question/ approval/ artifact/
│   ├── orchestration/      # 编排图用例 + 委派校验
│   ├── agent-loop/         # runner / context-builder / loop strategies
│   ├── memory/ search/ model-gateway/ model-config/ tool-package/
│   └── tools/              # 校验链、审批桥用例
├── infra/
│   ├── file-store/ indexer/ model/ tools/ sandbox/ lock/ events/ static/ util/
├── server/
│   ├── http-routes/ ws/ errors.ts
└── bootstrap/
    ├── composition-root.ts     # 唯一装配处
    └── self-check.ts           # 启动自检（注册表一致性/对账/临时文件）
web/                        # 前端（独立工程，React 19 + antd 6；画布候选 React Flow）
tests/{unit,integration,e2e}  # 含 helpers-*.ts 测试替身与装配助手
scripts/                    # 工程脚本：dev 并行启动、依赖门禁 ratchet（ESLint Node API）
tools/                      # 门禁基线等工具数据（import-ratchet.json）
```

## 9. 错误与结果约定

- **领域/应用层**：返回 `Result<T>`，错误码取自 `shared/errors.ts`（与 contract §4 同一套：`ERR_CONFLICT`/`ERR_FORBIDDEN`/`ERR_FORBIDDEN_PATH`/`ERR_ORCHESTRATION_EDGE`/`ERR_ORCHESTRATION_INVALID`/`ERR_QUESTION_PENDING`/`ERR_APPROVAL_REQUIRED`/`ERR_APPROVAL_REJECTED`/`ERR_TOOL_REJECTED`/`ERR_VALIDATION`/`ERR_NOT_FOUND`/`ERR_MODEL`/`ERR_CMD_TIMEOUT`/`ERR_CMD_FORBIDDEN`/`ERR_NET_OFFLINE`/`ERR_INTERNAL`）。
- **边界抛异常**：适配器内部 IO 失败、编程错误（未注册依赖、非法状态组合）→ 抛出并被 `server/errors.ts` 与 `Dispatcher` 捕获，转为 `ERR_INTERNAL` + 审计。
- **三层映射**：领域 `Result` → REST `{code,message}`；→ 模型工具 `{ok:false,code,reason}`；→ 会话事件 `kind=error`。三者共用同一错误码集（D18-⑤d 的单一规范）。

## 10. 测试与可替换性

| 层 | 测什么 | 替身 |
| --- | --- | --- |
| `domain`（无 IO） | 状态机、规则、路径/委派/归属/可见性判定 | 无（纯函数） |
| `application` | 用例编排、锁边界、事件投影顺序 | 全部 `*Store`/`Gateway` 换 InMemory + 固定 Clock/ID |
| `infra` | 适配器契约（原子写、seq 单调、索引命中、模型流归一化） | 每端口一份**契约测试**，实现与 InMemory 替身同套断言 |
| `server` | 路由校验、错误映射、WS 事件形状 | supertest + fake socket |
| E2E | prd §9 主路径 | 脚本化网关（模型替身）剧本 + 临时项目目录 |

**契约测试**是关键约定：`ports/*.ts` 的每个实现（真实适配器 + InMemory 替身）都要通过同一组断言，防止"测试替身与真实实现语义漂移"。

## 11. 开发门禁与规范

1. 依赖规则：eslint zones + ratchet（§2）；PR 里出现新的跨层 import 直接失败。
2. 端口只有一处实现注册：组合根；适配器不得被业务代码直接 import。
3. 新增领域事件必须登记 `domain/events`，且同步 `contract.md` 的 WS 映射。
4. 命名：端口 `XxxStore/Gateway/Registry/Policy/Resolver`；适配器 `XxxAdapter` 或 `Xxx<Tech>`（如 `FileSessionLogStore`）。
5. 每个端口方法都要有失败语义（返回哪些错误码），写进接口注释。
6. 覆盖率：`domain` + `infra` 关键模块 ≥ 80%（对齐 testing/plan.md §4）。

## 12. 演进路线

| 阶段 | 会新增/替换 | 影响面 |
| --- | --- | --- |
| MVP | 本文全部端口 + 文件系统适配器 + InMemory 替身 | — |
| **D20 模型配置模块**（本轮设计） | `ModelConfigStore` / `ModelCatalog` / `ProviderKindAdapter`×5 + `data/model-config.json` + 配置审计 | 不动容器 |
| U8 自定义工具包 | `ToolPackageRegistry.register` + 包安装的审批与信任 | 不动容器 |
| U9 Agent 配置提交（**部分已随 D20 定案**） | 提示词/loop/模型三项：实例配置写入 + `EffectiveAgentConfigResolver.invalidate` + 版本审计；**剩余**工具挂载编辑 | 不动容器 |
| U11 第三方/MCP 工具 | 新增 `ExternalToolProvider` 端口（进程/远端）+ 隔离与超时 | 组合根加一行绑定 |
| P1 向量检索 | 换 `SearchIndex`/新增 `EmbeddingProvider` 实现 | 组合根换绑定 |
| P2 多进程/并发 | 换 `LockManager`（文件锁/DB 锁）与 `EventBus`（跨进程） | 端口不变，实现替换 |

## 13. 风险与未决

| 风险 | 应对 |
| --- | --- |
| 容器与注册表边界被侵蚀（把配置塞进构造参数） | §5.5 约束写进 review 清单；新增依赖须说明"是能力还是配置" |
| 端口过度拆分（每个小函数一个端口） | 端口只在**跨层或需替换**时建立；同层内部用普通模块 |
| 事件投影顺序问题（先盘后推） | 落盘成功后才 `publish`；投影失败只告警不阻断主流程（D18-⑤a） |
| 自研容器缺生态 | `Container` 是端口，可整体替换实现 |

未决：U8（工具包格式与信任模型）、U9 剩余（工具挂载编辑与配置回滚）、U11（第三方/MCP 接入）；是否引入 `AsyncLocalStorage` 传递 `TurnContext`（当前显式传参，避免隐式上下文）；前端状态管理选型（画布与列表共享实时状态）。
