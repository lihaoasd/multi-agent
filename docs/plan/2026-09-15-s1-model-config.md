# 开发方案 · S1 模型配置模块 + Agent 配置提交

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §5 · 执行结果见 [修改记录](../changes/2026-09-15-s1-model-config.md)
> 关联：[model-config.md](../design/model-config.md)（本次落地的设计真源）、[agent-templates.md](../design/agent-templates.md) §4、[abstraction.md](../design/abstraction.md) §4.2/§4.6/§5.5、[contract.md](../api/contract.md) §2

## 1. 目标与范围

把 `model-config.md` 的设计落成可跑通的能力：**用户可添加常见供应商、管理模型条目、为 Agent 配置模型 / loop / 提示词**，且改完**无需重启**即时生效、密钥永不明文外发。

| 在范围内 | 不在范围内（留后续阶段） |
| --- | --- |
| 供应商与模型条目 CRUD、连通性测试、模型发现、批量登记、默认路由 | 项目与实例层配置（需 ProjectStore，S2 落地；本轮先做**模板层**，校验器已就绪可复用） |
| 五种协议适配器（openai-compatible / anthropic / gemini / ollama / mock）+ 流式归一化 + 脱敏 | 真实模型调用接入 loop（S4）、WS 真实网关（S3，本轮用 `EventBroadcaster` 端口占位） |
| Agent 模板：内置只读、基于复制新建、提示词/loop/模型三项提交、历史快照、平台审计 | 工具与工具包挂载编辑（U9 剩余）、配置回滚 UI（U15） |
| 前端：首页"模型"模块与 Agent 模块（含编辑） | 项目/工具模块界面（S2/S4） |
| 遗留配置迁移（`.env` `MODELS__PROVIDERS`、旧 `model-config.json` v0）与首次初始化兜底 | 密钥加密（U14）、用量统计（U13）、代理（U16） |

## 2. 关键决定

1. **端口先行**：`ports/{file-store,model,model-config,role-templates,events}.ts` 定义数据模型与失败语义，`infra` 只做适配；`ModelCatalog` 的 `current()` 放进端口（服务层与路由共用快照，避免重复读盘）。
2. **`.env` 读取口径统一**：`.env` 文件内容**不会**写回 `process.env`，因此配置解析、env 模式凭证、遗留导入统一走 **`loadEnvMap()`（文件 + 进程环境合并，后者优先）**。这是本轮踩到两次的真实缺陷（遗留导入不触发、env 凭证显示"未设置"）。
3. **首次初始化四步**（model-config.md §11）：空配置 → 检测 v0/坏文件则备份 → 导入 `MODELS__PROVIDERS` → 仍为空则创建内置 `mock` 供应商与模型（保证 prd §9 验收 2）。
4. **凭证解析边界**：`file` 空值返回 `null`（mock/ollama 无需密钥），"真实供应商必须有密钥"由**创建/编辑时**的校验保证；`env` 缺失在保存时即 `ERR_VALIDATION`。
5. **适配器归一化**：五种 kind 的 SSE/NDJSON 差异全部收敛在 `infra/model/providers/*`，统一产出 `ModelChunk`；HTTP/网络/解析错误映射 `ERR_MODEL`，错误文本先过 `redactSecrets`。
6. **审计与模板快照**：平台/模板变更写 `<DATA_DIR>/config-audit.jsonl`（不含密钥明文与提示词全文）；用户模板每次保存写 `<DATA_DIR>/roles/<roleId>.history/<ts>.yaml`。
7. **模板层先行**：实例覆盖需要 ProjectStore（S2），本轮先交付**模板层三项配置 + 共用校验器**（`validate-agent-config.ts`），S2 直接用同一校验器接 `PATCH /api/projects/:pid/team/:iid`。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S1.1 | `src/ports/{file-store,model,model-config,role-templates,events}.ts`（含 `Credential`/`ModelConfigSnapshot`/`ProviderKindAdapter`/`RoleTemplateStore` 等）+ `tokens.ts` 扩到 12 个 Token |
| S1.2 | `src/shared/model-presets.yaml`（9 家 + mock）、`src/shared/roles/*.yaml`（8 个内置角色模板，默认模型 `mock`）、`src/shared/loop.ts`（策略/步骤常量与参数范围） |
| S1.3 | `src/infra/file-store/{file-store,model-config-store,role-template-store}.ts`（原子写、revision 乐观并发、v0/坏文件备份、YAML 模板读写与历史快照） |
| S1.4 | `src/infra/model/{stream,json,http,redact,gateway,registry,presets}.ts` + `providers/{openai-compatible,anthropic,gemini,ollama,mock}.ts` |
| S1.5 | `src/infra/config/secret-resolver.ts`、`src/infra/events/noop-broadcaster.ts`、`src/infra/config/env-config.ts`（新增 `loadEnvMap`） |
| S1.6 | `src/application/model-config/{catalog,validate,dto,references,service}.ts`（15 条校验、删除/停用引用保护、测试/发现/批量、迁移导入、初始化兜底） |
| S1.7 | `src/application/team/{validate-agent-config,agent-config-service}.ts` |
| S1.8 | `src/server/http-routes/{model-config,agent-templates,parse}.ts` + `app.ts`/`composition-root.ts`/`main.ts` 装配 |
| S1.9 | 前端：`web/src/api/{client,modelConfig,agentTemplates}.ts`、`web/src/pages/{ModelModule,AgentModule}.tsx`、`App.tsx` 四模块导航（项目/工具标"后续阶段"） |
| S1.10 | 测试 12 个文件 83 条（见 §4） |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.json` / `-p web/tsconfig.json` | 均 0 错误 |
| 测试 | `vitest run` | **12 files / 83 tests 全通过** |
| 依赖门禁 | `eslint .` + `node scripts/import-ratchet.mjs` | exit 0；越层违规 0（基线 0） |
| 真实服务验收（prd §9 验收 8） | 起服务（3100）后 curl 走查 | 遗留导入创建 `deepseek-flash`（env 凭证 `hasValue=true`）→ 新增 Ollama 供应商 → 模型条目/批量登记 → 路由校验与保存 → 删除保护 409 → 8 个内置模板 → 内置 403 → 复制新建 201 → 三项提交 200 → loop 越界 400 → 历史快照 2 份 |
| 密钥卫生 | 响应体 / `data/model-config.json` / 审计文件 | 均**不含明文密钥**（env 模式只存变量名；接口只回掩码） |
| 中文与 UTF-8 | curl 发 UTF-8 提示词并回读 | 正确往返（PowerShell `Invoke-WebRequest` 的 `?` 是客户端编码问题，非服务端） |
| 前端 | `vite build` + `GET /` | 构建成功；页面 HTML 引用新产物 hash |
| 失败路径 | 本机无 Ollama 时 `discover` | 502 `ERR_MODEL`（网络错误归一化） |

## 5. 不做与遗留

- **实例层配置（`PATCH /api/projects/:pid/team/:iid`）留到 S2**：需要 ProjectStore；校验器与生效机制（`EffectiveAgentConfigResolver.invalidate`）本轮已就位。
- WS 真实网关留 S3：本轮只管道路由广播调用点（`EventBroadcaster`），`model-config.updated` / `agent-config.updated` 已被测试断言。
- 未做：模型用量统计（U13）、密钥加密（U14）、配置回滚 UI（U15）、代理（U16）、工具挂载编辑（U9 剩余）。
- 端口 3000 仍被 14:29 启动的旧实例占用（非本轮），验收统一用 3100。
