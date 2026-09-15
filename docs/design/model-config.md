# 模型配置与 Agent 配置设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D20、prd FR-10/FR-34/FR-35、US-22/US-23
> 关联：[agent-runtime.md](agent-runtime.md)（§5 模型路由、loop 执行）、[agent-templates.md](agent-templates.md)（模板与实例配置）、[abstraction.md](abstraction.md)（§4.2 模型端口、§5.5 动态配置）、[data-storage.md](data-storage.md)（落盘布局）、[ui.md](ui.md)（模型模块与 Agent 模块）、[contract.md](../api/contract.md)
> 本文件是**模型供应商、模型条目、全局路由与 Agent 配置提交**的设计真源；`agent-runtime.md` §5 只保留路由解析链，不重复本文件细节。

## 1. 定位与边界

- **模型配置模块**回答"这台机器能调用哪些模型"：用户添加**供应商**（一次连接：协议 + 地址 + 凭证），在其下维护**模型条目**，并设定**全局默认路由**。
- **Agent 配置**回答"某个角色用哪个模型、哪套 loop、哪段提示词"：系统模板提供默认值，项目实例可覆盖（两层，见 §2）。
- 本模块**只配置、不执行**：调用与流式归一化仍归 `ModelGateway`（agent-runtime §5 / abstraction §4.2）。
- 权限边界：本机单用户、无账号体系（prd §2），因此**没有**"谁能改模型配置"的授权链；**唯一的硬约束是密钥不得出现在任何读路径**（§5）。

## 2. 配置分层与解析链

```
平台级  data/model-config.json          供应商 + 模型条目 + 全局默认路由（UI 可改，即时生效）
  ▲
模板级  data/roles/<roleId>.yaml        systemPrompt / defaultLoop / defaultModel / packages / tools / …
  ▲                                    （首页 Agent 模块可编辑；内置模板只读，需"基于内置复制新建"）
实例级  project.json  team[]            prompt / loop / model 覆盖（创建时快照模板默认值，D16-⑤）
```

**有效配置解析链**（`EffectiveAgentConfigResolver`，abstraction §5.5）：

```
实例覆盖 → 模板快照 → loop 步骤默认（routing.stepOverrides） → 平台 routing.defaultModelId
```

- 任一层解析到的模型 id 必须是**已启用的模型条目**；解析失败**不回退到其它模型**，直接返回 `ERR_MODEL` 并回注错误事件（避免"悄悄换模型"，D20-⑥）。
- 解析结果按 `(projectId, instanceId, configVersion)` 缓存；写入任一层配置后 `invalidate`（§9）。
- 提示词同理只有一处覆盖语义：实例 `prompt` 非空则整段替换模板 `systemPrompt`（**不是**拼接；平台注入段由 `ContextBuilder` 在运行期追加，见 agent-runtime §4）。

## 3. 供应商（Provider）

```jsonc
{
  "id": "deepseek",                 // 供应商 id，全局唯一，^[a-z0-9][a-z0-9-]{1,31}$
  "name": "DeepSeek",               // 展示名
  "kind": "openai-compatible",      // 协议适配器（§6），必须已注册
  "baseUrl": "https://api.deepseek.com/v1",
  "credential": { "mode": "env", "envName": "DEEPSEEK_API_KEY" },   // 或 { "mode": "file", "value": "sk-…" }
  "headers": {},                    // 可选附加请求头（如自建网关的鉴权头）
  "enabled": true,
  "timeoutMs": 60000,               // 单次请求超时，受平台上限约束
  "presetId": "deepseek",          // 来自预置目录则为预置 id；自定义为 null
  "createdAt": "…", "updatedAt": "…"
}
```

- 一个供应商 = 一次连接；**同一家可以有多个供应商条目**（如两个自建 OpenAI 兼容网关、两个 Ollama 实例）。
- `kind` 与 `baseUrl` 的关系：预置模板给出默认 `baseUrl`，用户可改（自建代理/中转站）；`kind` 也可改，但改 kind 时 UI 必须重填 `baseUrl`（端点半径不同，§6）。
- `enabled=false`：该供应商下所有模型的调用直接失败（`ERR_MODEL`），用于临时停用而非删除。

## 4. 模型条目（Model）

```jsonc
{
  "id": "deepseek-chat",            // 模型条目 id，全局唯一；Agent 的 model 字段引用它
  "providerId": "deepseek",         // 必须指向存在的供应商
  "model": "deepseek-chat",         // 传给后端的真实模型名（火山方舟填 endpoint id）
  "displayName": "DeepSeek Chat",
  "capabilities": ["chat", "stream", "tools"],   // 能力标记，供 Agent 挂载工具时告警
  "contextWindow": 64000,
  "maxOutputTokens": 8192,
  "defaultParams": { "temperature": 0.6 },
  "enabled": true
}
```

- **为什么与供应商分开**：一家供应商可以挂多个模型（同族大小杯、推理模型、embedding），Agent 的 `model` 需要精确到模型而不仅是供应商；这也是本模块对既有"`model` 引用 provider id"口径的修订（D20-①，兼容见 §11）。
- `capabilities` 是**声明**不是探测：`tools` 未声明时，Agent 若挂载了工具包，UI 给出"该模型未声明工具能力"的告警，运行期仍按模型实际返回处理。
- `defaultParams` 与 loop 参数的关系：模型参数（temperature/maxTokens 等）来自模型条目；loop 参数（maxIterations/toolBudget/stepModelOverride）来自 Agent 配置（agent-templates §4）。二者不重叠。

## 5. 凭证与安全

| 项 | 口径 |
| --- | --- |
| 存储模式 | `file`：密钥明文存 `data/model-config.json`（`data/` 已在 `.gitignore`，不入库）；`env`：只存变量名，值由进程环境提供 |
| 读路径 | **REST 响应、审计、日志、错误事件一律不含明文**；列表/详情只回 `credential: { mode, envName?, hasValue, masked }`（`masked` 形如 `sk-***c3b2`） |
| 写入 | PATCH 时 `credential` 字段省略 = 保持原值；提供 `{ "mode": "file", "value": "" }` 表示清除；UI 显示掩码而非原值 |
| 脱敏 | `ModelGateway` 外挂脱敏装饰器：出站 `Authorization`/`x-api-key`/`x-goog-api-key` 与入站错误体统一替换为 `***`；供应商返回的错误正文截断后回注 |
| 审计 | 记"已更新密钥"与掩码，不记明文；`credentialTouched: true` 标记 |
| 边界 | 不做密钥加密与系统钥匙串集成（本机单用户，见 §14）；不提供密钥导出接口 |

> 例外说明：`env` 模式下若变量不存在，保存时即 `ERR_VALIDATION`（不能等到调用才失败）；`file` 模式必须显式确认"明文存储"提示。

## 6. 适配器 kind 与预置供应商目录

### 6.1 五种 kind

| kind | 调用端点 | 认证 | 流式形态 | 覆盖的供应商 |
| --- | --- | --- | --- | --- |
| `openai-compatible` | `POST {baseUrl}/chat/completions` | `Authorization: Bearer <key>` | SSE，`data:` 行 + `[DONE]`，增量在 `choices[].delta`（含 `tool_calls`） | DeepSeek、OpenAI、百炼兼容模式、Kimi、GLM、火山方舟、自定义 |
| `anthropic` | `POST {baseUrl}/messages` | `x-api-key` + `anthropic-version` | SSE 命名事件（`content_block_delta` 等） | Anthropic Claude |
| `gemini` | `POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` | SSE，`candidates[].content.parts[]`（`functionCall` 为工具调用） | Google Gemini |
| `ollama` | `POST {baseUrl}/api/chat` | 无（可选 Bearer） | NDJSON 逐行 JSON | Ollama（本地） |
| `mock` | 进程内 | — | 剧本化（可编程响应） | 离线演示与测试 |

- 归一化目标：既有 `ModelChunk`（`text-delta` / `reasoning-delta` / `tool-call` / `usage`，abstraction §4.6）。**新增 kind 只实现适配器，不动 `ModelGateway` 及以上**（扩展步骤见 abstraction §7）。
- 预留但本轮不实现：`bedrock`、`vertex`、`azure-openai`、通用 `openai-responses`。

### 6.2 预置目录（9 家 + mock）

| presetId | 展示名 | kind | 默认 baseUrl | 凭证 | 模型发现 |
| --- | --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | openai-compatible | `https://api.deepseek.com/v1` | Bearer | `GET /models` |
| `openai` | OpenAI | openai-compatible | `https://api.openai.com/v1` | Bearer | `GET /models` |
| `anthropic` | Anthropic Claude | anthropic | `https://api.anthropic.com/v1` | `x-api-key` | `GET /models` |
| `gemini` | Google Gemini | gemini | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` | `GET /models` |
| `dashscope` | 阿里通义千问（百炼） | openai-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer | `GET /models` |
| `moonshot` | 月之暗面 Kimi | openai-compatible | `https://api.moonshot.cn/v1` | Bearer | `GET /models` |
| `zhipu` | 智谱 GLM | openai-compatible | `https://open.bigmodel.cn/api/paas/v4` | Bearer | `GET /models` |
| `volcengine-ark` | 火山方舟 豆包 | openai-compatible | `https://ark.cn-beijing.volces.com/api/v3` | Bearer | 不支持（模型名=推理接入点 id，手工填） |
| `ollama` | Ollama（本地） | ollama | `http://127.0.0.1:11434` | 无 | `GET /api/tags` |
| `mock` | Mock（离线演示） | mock | — | — | 内置固定模型 |

- 预置目录随仓库（`src/shared/model-presets.yaml`，只读），**不含任何密钥**；条目内容为 `{presetId, name, kind, baseUrl, credentialHint, suggestedModels[], docsUrl}`。
- `suggestedModels[]` 是**示例清单**（可编辑，随供应商版本变动）：新建供应商时可一键生成模型条目，也可留空后从"模型发现"拉取（§7）。文档不硬编码具体模型名清单，以供应商控制台为准。
- 自定义供应商：kind 手选 + 名称/baseUrl 手填，`presetId: null`；等价于"预置目录之外的第六类"，无需额外机制。

## 7. 连通性测试与模型发现

| 能力 | 接口 | 行为 |
| --- | --- | --- |
| 连通性测试 | `POST /api/model-providers/:id/test` `{mode:"models"\|"chat"}` | `models`：调用供应商列模型端点（最省额度）；`chat`：对指定模型发一次 `max_tokens=1` 的非流式最小请求。返回 `{ok, latencyMs, models?, error?}` |
| 模型发现 | `GET /api/model-providers/:id/discover` | 拉取该供应商可用模型名列表（§6.2"模型发现"列）；不支持或失败 → 返回 `ERR_MODEL` + 建议手工填写，UI 不阻断 |
| 批量导入 | `POST /api/models/bulk` `{providerId, models:[{model, displayName?}]}` | 把发现/建议清单批量建成模型条目；已存在的 `model` 名跳过并回报 |

- 连通性测试只做**最小代价**调用；结果**不写会话日志**，只写平台审计（`action:"test"`）。
- 测试与真实调用走同一适配器路径（同一凭证解析、同一脱敏装饰），避免"测试通过但调用失败"。

## 8. 校验规则与失败语义

| # | 规则 | 失败 |
| --- | --- | --- |
| 1 | `provider.id` / `model.id` 格式合法且全局唯一 | `ERR_VALIDATION` |
| 2 | `kind` 必须是已注册适配器 | `ERR_VALIDATION`（点名可用 kind） |
| 3 | `baseUrl` 为 http/https 且非空（`mock` 免） | `ERR_VALIDATION` |
| 4 | `env` 模式：`envName` 合规且**当前环境存在该变量** | `ERR_VALIDATION` |
| 5 | `file` 模式：新增时 `value` 非空；编辑省略=保持 | `ERR_VALIDATION` |
| 6 | `model.providerId` 必须存在且 `enabled` | `ERR_VALIDATION` |
| 7 | `model.model` 非空；同一供应商下 `model` 名不重复 | `ERR_VALIDATION` |
| 8 | 删除供应商：其下**存在模型条目**即拒绝 | `ERR_CONFLICT` + `detail.referrers` |
| 9 | 删除模型：被模板/实例引用即拒绝 | `ERR_CONFLICT` + `detail.referrers` |
| 10 | 停用模型：允许，但引用它的 Agent 下一回合解析失败 | UI 二次确认列引用；运行期 `ERR_MODEL` |
| 11 | `routing.defaultModelId` 必须指向已启用模型 | `ERR_VALIDATION` |
| 12 | `stepOverrides` 的 key 必须是已注册 loop 步骤名、value 指向已启用模型 | `ERR_VALIDATION` |
| 13 | Agent 提示词：非空、长度 ≤ 上限（默认 20000 字符，平台可配） | `ERR_VALIDATION` |
| 14 | Agent loop：`strategy` 已注册；`maxIterations` 1..20、`toolBudget` 0..200、`stepModelOverride` 指向已启用模型 | `ERR_VALIDATION` |
| 15 | 内置模板不可原地修改/删除 | `ERR_FORBIDDEN`（提示"基于内置复制新建"） |

- 错误码沿用 `contract.md` §4 既有集合（`ERR_VALIDATION`/`ERR_CONFLICT`/`ERR_NOT_FOUND`/`ERR_FORBIDDEN`/`ERR_MODEL`），**不新增错误码**；引用者与供应商原始错误放 `detail`。
- 供应商返回的 HTTP 错误映射为 `ERR_MODEL`，`detail` 含 `{ providerId, modelId, status, code?, message(截断+脱敏) }`。

## 9. 生效时机与缓存失效

| 用户动作 | 影响面 | 生效时机 | 需重启？ |
| --- | --- | --- | --- |
| 新增/编辑/停用供应商 | 其下模型的调用 | 下一次模型调用 | 否 |
| 新增/编辑模型条目 | 引用它的 Agent | 下一次模型调用 | 否 |
| 改全局默认路由 | 未显式指定模型的角色 | 下一回合解析 | 否 |
| 编辑系统模板（提示词/loop/模型） | **仅未来新建实例**（快照） | 保存即写模板文件 | 否 |
| 实例覆盖（提示词/loop/模型） | 该实例 | 下一回合开始（缓存失效）；运行中回合到可中断点 | 否 |
| 删除被引用的供应商/模型 | — | 被拒（§8 #8/#9） | — |
| 换 kind 适配器实现 / 改 `MODELS__CONFIG_FILE` | 全体 | 启动期装配 | **是** |

- 机制上只有两步：**原子写 `data/model-config.json` → `ModelCatalog.invalidate()`**；容器、注册表、进程均不变（abstraction §5.5 三约束）。
- 写入与缓存失效之间不存在"半生效"：缓存按文件版本号（`revision`）判定，读到新 `revision` 才重建解析结果。

## 10. 审计与留痕

| 记录 | 位置 | 内容 |
| --- | --- | --- |
| 平台配置审计 | `data/config-audit.jsonl`（append-only） | `{ id, ts, actor:"user", scope:"platform", target:{kind:"provider\|model\|routing", id}, action:"create\|update\|delete\|test\|import", diff:{changedFields[], before?, after?}, credentialTouched }` |
| 模板版本快照 | `data/roles/<roleId>.history/<ts>.yaml` | 每次保存只增一份完整快照（可列出/查看；**回滚 UI 后续**，§14） |
| 模板/实例审计 | `data/config-audit.jsonl`，`scope:"template"\|"instance"` | 同表；实例项含 `projectId`/`instanceId`，`diff` 只记字段名与摘要 |
| 会话内投影 | 会话 log（`kind=state` 或 `error`） | 实例配置变更广播 WS `agent-config.updated`；引用失效导致 `ERR_MODEL` 时落 `kind=error` 事件 |

- 审计**永不包含提示词全文与密钥明文**：提示词只记长度与首 40 字符摘要，密钥只记掩码。
- 平台审计与项目内会话日志分离：模型配置属机器级，不属任何项目文件夹。

## 11. 与 `.env` 的关系、迁移与兼容

`.env` 从"模型配置唯一来源"降为**引导与边界默认**：

| 键 | 作用 |
| --- | --- |
| `MODELS__CONFIG_FILE` | 运行时模型配置文件路径（默认 `data/model-config.json`） |
| `MODELS__DEFAULT` | 首次初始化时的默认模型 id（仅当配置文件不存在且无可导入条目） |
| `MODELS__IMPORT_FROM_ENV` | 是否允许从遗留 `MODELS__PROVIDERS` 一次性导入（默认 `true`） |
| `MODELS__REQUEST_TIMEOUT_MS` | 单次请求超时上限（供应商条目只能收紧，不能突破） |
| `MODELS__MAX_PROMPT_CHARS` | 提示词长度上限（默认 20000，§8 #13） |

迁移与兼容：

1. **`.env` 的 `MODELS__PROVIDERS`**（现状形状 `{id, kind, baseUrl, apiKeyEnv, model}`）：配置文件不存在时一次性导入 → 每个条目生成 1 个供应商 + 1 个同名模型条目（`apiKeyEnv` → `credential:{mode:"env"}`）；`MODELS__DEFAULT` → `routing.defaultModelId`。导入后 `.env` 该键仅作历史留存，UI **不再读写**，审计记 `action:"import"`。
2. **旧值兼容**：Agent/模板/实例的 `model` 字段若命中**供应商 id**（而非模型条目 id），且该供应商**只有一个启用模型**，则解析到该模型并在审计写一条告警（提示"该字段已按模型条目口径解析，建议改为显式模型 id"）；若该供应商有多个启用模型，则解析失败 `ERR_MODEL`，要求用户显式指定。**不静默改写配置文件**。
3. **遗留 `data/model-config.json` 旧形状**（`{entries[], defaultModel}`，无 `schemaVersion`）：视为 v0 → 启动自检**不自动导入**，备份为 `model-config.v0.bak.json` 并在 UI 提示一次；用户点"导入"走 `POST /api/model-config/import?source=v0`。
4. **遗留 `data/agent-models.json`**（旧 `roleId → 条目 id` 映射，已被本轮设计取代）：不再读取；提示用户其映射应写入角色模板 `defaultModel`（不自动改文件）。
5. `schemaVersion` 当前为 `1`；未来不兼容变更递增版本并要求显式迁移（与 `data-storage.md` §9 一致）。

## 12. 端口与代码落点（对齐 abstraction.md）

| 组件 | 职责 | 层 / 落点 |
| --- | --- | --- |
| `ModelConfigStore` | `data/model-config.json` 原子读写 + `revision` 乐观并发 + 审计追加 | ports / infra/file-store |
| `ProviderKindAdapter` | 单协议适配：`stream` / `listModels?` / `test?` / `capabilities`（由 `ModelProvider` 更名，避免与"用户配置的供应商"混淆） | ports/model.ts / infra/model/providers/ |
| `ProviderKindRegistry` | `kind → 适配器` 注册与解析（由 `ProviderRegistry` 更名） | infra/model |
| `ModelCatalog` | `modelId → {provider, credential, model 名, params, kind}` 解析 + `revision` 缓存 + `invalidate()` | application/model-config |
| `ModelGateway` | 按 `ModelId` 路由到适配器，统一 `ModelChunk`，外挂脱敏装饰 | infra/model |
| `ModelConfigService` | 供应商/模型/路由的增删改查 + 校验 + 测试/发现 + 迁移导入 | application/model-config |
| `AgentConfigService` | 模板 CRUD（复制新建/编辑/停用）与实例覆盖写入 + 校验 + 快照 + 审计 | application/team |
| 预置目录 | 9 家 + mock 的 kind/baseUrl/凭证提示/建议模型 | src/shared/model-presets.yaml（只读） |

- 关键约束：`ModelCatalog` **不缓存凭证到进程外**、不进日志；`AgentConfigService` 写实例配置后必须调用 `EffectiveAgentConfigResolver.invalidate(projectId, instanceId)`。

## 13. 契约摘要

| 面 | 内容 |
| --- | --- |
| REST | `GET /api/model-presets`、`GET\|POST /api/model-providers`、`PATCH\|DELETE /api/model-providers/:pid`、`POST /api/model-providers/:pid/test`、`GET /api/model-providers/:pid/discover`、`GET\|POST /api/models`、`POST /api/models/bulk`、`PATCH\|DELETE /api/models/:mid`、`GET\|PUT /api/model-routing`、`POST /api/model-config/import`；Agent 侧 `POST /api/agent-templates`、`PATCH /api/agent-templates/:roleId`、`GET\|PATCH /api/projects/:pid/team/:iid` |
| WS | 新增下行 `model-config.updated`（供应商/模型/路由变更）、`agent-config.updated`（模板或实例配置变更） |
| 错误码 | 沿用既有集合，不新增（§8） |

> 完整请求/响应字段、状态码与 WS payload 见 [contract.md](../api/contract.md) §2.5/§2.6/§3。

## 14. 未决与后续

| # | 事项 | 说明 |
| --- | --- | --- |
| U9（剩余） | 工具与工具包挂载编辑 | 本轮开放模型/loop/提示词三项，工具挂载与自定义包（U8）仍只读 |
| U13 | 模型费用与用量统计 | 按模型条目聚合 token/费用；需先定价格表来源与统计落点 |
| U14 | 密钥加密与系统钥匙串 | 本机明文 + 文件权限为 MVP 口径；加密需要新依赖与解锁流程 |
| U15 | 配置回滚 UI | 模板历史快照已落盘（§10），回滚交互与冲突处理未定 |
| U16 | 网络代理与自签证书 | 企业代理/内网网关场景；涉及 `infra` HTTP 客户端配置 |
| — | 自定义 loop 策略插件、提示词占位符语法、模型能力自动探测 | 明确不在本轮（plan §5） |
