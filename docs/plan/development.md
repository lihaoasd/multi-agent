# 开发计划 · Agent Haness MVP（编码阶段执行计划）

> 类别：plan · 状态：草稿(待评审) · 日期：2026-09-15 · 类型：**总计划**（跨阶段；单体改动方案仍按 `docs/plan/YYYY-MM-DD-<topic>.md` 单独写）
> 关联：[prd.md](../requirements/prd.md)（需求真源与 §9 验收）、[docs/README.md](../README.md)（文档地图）、[architecture.md](../design/architecture.md)、[abstraction.md](../design/abstraction.md)（端口/DI/门禁）、[data-storage.md](../design/data-storage.md)、[testing/plan.md](../testing/plan.md)（规则 1~31）
> 本文件是 **prd §9 验收 5 点名的"编码阶段执行计划"**；它不引入新需求，只把已定稿的设计排成可执行顺序。

## 1. 目的与使用方式

- **解决什么**：设计真源（v0.3 定稿）已有 14 份 `docs/design/*`，但没有"先写哪块、按什么顺序、每块怎么验收"的执行顺序；本文件给出阶段划分、依赖、验收与风险。
- **不是什么**：不是需求或设计真源（冲突时以 `prd.md` / `design/*` 为准）；不是排期承诺（按阶段顺序执行，不绑定日期）。
- **阶段编号**：用 **`S0`~`S9`**。⚠️ 历史里程碑编号 `M1~M14` 的出处已随重启提交删除（README §3.2），新增文档**不得复用**，故本计划不用 `M` 前缀。
- **每阶段的产物**：① 代码与测试；② 该阶段的 `docs/plan/YYYY-MM-DD-<topic>.md`（改动方案）与 `docs/changes/YYYY-MM-DD-<topic>.md`（修改记录）；③ 涉及接口/存储的实现回写（`contract.md` 头部已声明"编码阶段以实际实现为准并回写"）。

## 2. 现状与前置条件

| 项 | 现状 |
| --- | --- |
| 代码 | **无**。`0217e21` 已清空旧实现，仓库仅剩 `docs/`（`.gitignore` 排除 `data/`、`.env`） |
| 设计 | `docs/` 30 份文档定稿（含本轮新增 `model-config.md`）；端口/DI/门禁契约见 `abstraction.md` |
| 依赖 | 根目录有 `node_modules`（antd/react/vite/vitest/fastify/tsx/typescript 等残留），但 `package.json`、`tsconfig*.json`、`vitest.config.js`、`eslint` 配置均随重启删除 → **S0 需重建工程脚手架** |
| 技术栈（已定） | TypeScript + Node ≥ 20；Fastify（REST+WS+静态）；React 18 + Vite + antd 5（画布候选 React Flow）；Vitest；纯文件系统存储；不引 ORM/DB/重型 SDK |
| 运行数据 | `data/` 内有旧实现残留（`model-config.json` 旧形状、`agent-models.json`）；`model-config.md` §11 已定兼容策略，S1 实现时按其处理 |

## 3. 阶段总览

| 阶段 | 目标 | 主要交付物 | 依赖 | 覆盖测试规则 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **S0** | 工程脚手架与依赖门禁 | `package.json`/`tsconfig`/`vite`/`vitest`/eslint zones+ratchet、六层目录、`Container`、`/health` | — | — | **已完成（2026-09-15）**：[方案](2026-09-15-s0-scaffold.md) · [记录](../changes/2026-09-15-s0-scaffold.md) |
| **S1** | **模型配置模块 + Agent 配置提交**（本轮设计落地） | 5 个协议适配器、`ModelConfigStore`/`ModelCatalog`、`/api/model-*`、模板与实例三项配置、前端"模型"模块 | S0 | 27~31 | **已完成（2026-09-15，模板层 + 模型配置）**：[方案](2026-09-15-s1-model-config.md) · [记录](../changes/2026-09-15-s1-model-config.md)｜实例层覆盖随 S2 |
| **S2** | 存储底座与项目/团队 | `FileStore`/`LockManager`/`IdGenerator`/`Clock`/`Logger`、project CRUD、创建向导、实例快照与停用 | S0 | 8 | **已完成（2026-09-15）**：[方案](2026-09-15-s2-project-team.md) · [记录](../changes/2026-09-15-s2-project-team.md) |
| **S3** | 会话与单工调度 | `SessionLogStore`（seq/轮转）、`SessionMetaStore`、dispatcher occupancy、WS 网关（先盘后推） | S2 | 1、5、9 | **已完成（2026-09-15）**：[方案](2026-09-15-s3-sessions-dispatcher.md) · [记录](../changes/2026-09-15-s3-sessions-dispatcher.md) |
| **S4** | Agent loop 与工具执行 | `LoopRegistry`+三策略真实形态、`ContextBuilder`、`ToolRegistry`/`ToolExecutor`、沙箱与审批桥 | S1、S3 | 2、3、11、26 | **已完成（2026-09-15）**：[方案](2026-09-15-s4-agent-loop-tools.md) · [记录](../changes/2026-09-15-s4-agent-loop-tools.md) |
| **S5** | 记忆与检索 | `MemoryStore`、滚动摘要（可重放派生）、2-gram 倒排索引、检索接口 | S3 | 6、7、13 | **已完成（2026-09-15）**：[方案](2026-09-15-s5-memory-search.md) · [记录](../changes/2026-09-15-s5-memory-search.md) |
| **S6** | 产出物、任务、询问 | `workdir_edit`+归属校验、artifact manifest+版本+回退、任务发布/领取/汇报、询问阻塞与答复 | S4、S5 | 4、10、12、15~18、21、24、25 | **已完成（2026-09-15）**：[方案](2026-09-15-s6-work-artifacts-tasks.md) · [记录](../changes/2026-09-15-s6-work-artifacts-tasks.md) |
| **S7** | 编排画布与前端完整化 | `/api/projects/:pid/orchestration`、委派边约束、画布、项目页 2/3 栏、右栏三列表、工作日志 | S6 | 22、23 | **已完成（2026-09-15）**：[方案](2026-09-15-s7-orchestration-ui.md) · [记录](../changes/2026-09-15-s7-orchestration-ui.md) |
| **S8** | 恢复、运行控制与验收收口 | 未完成回合恢复三选、排队消息恢复、暂停/停止、停止生成、进行中细条、导出 zip、`reindex`、文档回写 | S7 | 14、19、20 | **已完成（2026-09-15）**：[方案](2026-09-15-s8-recovery-runtime.md) · [记录](../changes/2026-09-15-s8-recovery-runtime.md) |
| **S9** | 全量验收与文档收口 | prd §9 脚本 1~8 全绿、覆盖率达标、`contract.md`/`data-storage.md` 回写 | S8 | 全部 | **已完成（2026-09-15）**：[方案](2026-09-15-s9-acceptance-closure.md) · [记录](../changes/2026-09-15-s9-acceptance-closure.md) |
| **S10** | 移除 mock 与"Agent 默认不配置模型"（需求变更，见 prd D21） | 删除 mock 适配器/kind/预置/启动兜底、8 个内置角色默认模型置空、`MODELS__DEFAULT` 生效、旧 kind 启动迁移、prd/design/api/testing 回写 | S9 | 27~31 | **已完成（2026-09-16）**：[方案](2026-09-16-s10-remove-mock.md) · [记录](../changes/2026-09-16-s10-remove-mock.md) |
| **S11** | Agent 模板库删除/停用 + 一键配置模型（需求变更，见 prd D22） | 用户模板可删（引用保护 409+点名）、内置模板可停用（数据目录覆盖，重启不丢）、`bulk-model` 批量设默认模型、`overview.unconfiguredAgents` 计数与一键设全局默认、前端多选/删除/配置交互 | S10 | 32 | **已完成（2026-09-16）**：[方案](2026-09-16-s11-template-delete-bulk-model.md) · [记录](../changes/2026-09-16-s11-template-delete-bulk-model.md) |
| **S12** | 工具模块瘦身（UI 简化，用户口径） | 只保留工具包表格、包内工具改为「详情」弹窗查看、移除已注册工具表格与 agent loop 策略列表；后端接口不变 | S11 | — | **已完成（2026-09-16）**：[方案](2026-09-16-s12-tools-module-simplify.md) · [记录](../changes/2026-09-16-s12-tools-module-simplify.md) |
| **S13** | `ask_user` 独立为 `interaction`（交互）工具包（需求变更，见 prd D23） | 基础包 7 → 8；工具注册 `package` 与包声明双向一致；8 个角色模板同步挂载；既有项目无需迁移 | S12 | — | **已完成（2026-09-16）**：[方案](2026-09-16-s13-ask-user-interaction-package.md) · [记录](../changes/2026-09-16-s13-ask-user-interaction-package.md) |
| **S14** | 删除「默认路由」功能（需求变更，见 prd D24；含平台默认模型） | 移除 `routing` 全链路（端口/存储/校验/服务/`/api/model-routing`/前端卡片/`MODELS__DEFAULT`）；生效链收敛两级；遗留 `routing` 键启动清理 + 审计 | S13 | 33 | **已完成（2026-09-16）**：[方案](2026-09-16-s14-remove-model-routing.md) · [记录](../changes/2026-09-16-s14-remove-model-routing.md) |

> 关键路径：`S0 → S1 → S2 → S3 → S4 → S6 → S7 → S8 → S9`。S5 与 S4/S6 可并行（只依赖 S3）；S10~S14 为 S9 之后的需求变更/UI 简化收口。

## 4. S0 · 工程脚手架与依赖门禁

**为什么先做**：`abstraction.md` §2 的六层依赖规则与 §11 门禁必须在**第一行业务代码之前**生效，否则越层 import 会随实现扩散（历史重构 P6 的教训）。

| 步骤 | 交付物 |
| --- | --- |
| S0.1 | `package.json`（scripts：`dev`/`build`/`start`/`test`/`lint`/`reindex`）、`tsconfig.json` + `tsconfig.build.json`、`vitest.config.js`、`vite` 前端工程（`web/`） |
| S0.2 | eslint 分层门禁：`no-restricted-imports` zones（六层）+ ratchet 计数，CI/本地 `npm run lint` 失败条件 |
| S0.3 | `src/{shared,ports,domain,application,infra,server,bootstrap}` 目录骨架 + `shared/result.ts`（`Result`/`AppError`/错误码全集，对齐 contract §4） |
| S0.4 | `Container`（`Token`/`register`/`registerInstance`/`resolve`/`tryResolve`/`createScope`/`dispose`/`assertGraph`）与组合根 `src/bootstrap/composition-root.ts` |
| S0.5 | `ConfigProvider`（`.env` 加载、`__` 分层键、JSON 数组、非法值回退）与 `Clock`/`IdGenerator`/`Logger` 端口 + 系统实现 |
| S0.6 | Fastify 服务骨架：`/health`、错误映射中间件、静态资源端口（`web/dist`）；`web/` 空壳页 |

**验收**：`npm run test` 全绿（至少 1 条 domain 纯函数测试）；`npm run dev` 起服务且 `GET /health` 200；`npm run lint` 在故意加入 `domain → node:fs` 时**必须失败**。

## 5. S1 · 模型配置模块 + Agent 配置提交（模型 / loop / 提示词）

**设计真源**：[model-config.md](../design/model-config.md)（全文）、[agent-templates.md](../design/agent-templates.md) §3/§4、[contract.md](../api/contract.md) §2"模型配置"、[abstraction.md](../design/abstraction.md) §4.2/§4.6。

| 步骤 | 交付物 | 关键约束 |
| --- | --- | --- |
| S1.1 | `src/ports/model.ts`、`src/ports/model-config.ts`、`src/ports/tokens.ts`：`ModelChunk`/`ModelRequest`（`model: ModelId`）、`ModelProviderConfig`/`ModelEntry`/`ModelRouting`/`ModelConfigSnapshot`、`ModelConfigStore`、`ProviderKindAdapter`、`ProviderKindRegistry`、`ModelCatalog` | 端口只放类型，不 import `infra`；失败语义写进接口注释 |
| S1.2 | `src/shared/model-presets.yaml`：9 家预置（DeepSeek/OpenAI/Anthropic/Gemini/百炼/Kimi/智谱/火山方舟/Ollama）+ `mock`；字段 `presetId/name/kind/baseUrl/credentialHint/suggestedModels/docsUrl` | **不含任何密钥** |
| S1.3 | `infra/file-store/model-config-store.ts`：读写 `data/model-config.json`、原子写、`revision` 乐观并发、审计追加 `data/config-audit.jsonl` | 审计不含密钥明文与提示词全文（§10） |
| S1.4 | `infra/model/providers/{mock,ollama,openai-compatible,anthropic,gemini}.ts` + 流式归一化 + **脱敏装饰器** | 差异只在此层；错误映射 `ERR_MODEL` 且 `detail` 脱敏 |
| S1.5 | `application/model-config/catalog.ts`：`modelId → ResolvedModel`（供应商+凭证+真实模型名+参数+kind），按 `revision` 缓存与 `invalidate()` | 凭证不进日志、不跨进程外泄 |
| S1.6 | `application/model-config/service.ts`：§8 全部 15 条校验、删除/停用引用保护（`detail.referrers`）、`test`/`discover`/`bulk`、`.env` 与 v0 迁移导入（§11） | 不新增错误码 |
| S1.7 | `server/http-routes/model-config.ts`：§13 全部端点 + WS `model-config.updated` | 列表/详情只回 `hasValue`/`masked` |
| S1.8 | `application/team/agent-config.ts`：模板"基于内置复制新建"、编辑三项、`data/roles/<roleId>.history/` 快照；实例覆盖（`PATCH team/:iid`）+ `EffectiveAgentConfigResolver.invalidate` + `configVersion+1` + WS `agent-config.updated` | 内置模板 → `ERR_FORBIDDEN`；模板编辑只影响未来实例 |
| S1.9 | 前端：全局导航"模型"模块（供应商/模型条目/默认路由/测试连接/安全提示）+ Agent 模块编辑（提示词+预览、loop 参数表单、模型下拉） | 与 `ui.md` §2.2/§2.3 一致；密钥只显掩码 |
| S1.10 | 测试：适配器**契约测试**（真实实现与 In-memory/Mock 同套断言）、规则 27~31 | 覆盖率：`domain`+`infra` 关键模块 ≥ 80% |

**验收（= prd §9 验收 8）**：本机起服务 → 模型模块添加 **Ollama 或 Mock**（离线）→ 填密钥/地址 →[测试连接]通过 → 登记模型条目 → 设全局默认 → Agent 模块"基于内置复制新建"模板并改提示词/loop/模型 → 项目内实例覆盖这三项 → **不重启**即在下一次调用生效 → 删除被引用供应商被拒并列出引用者 → 页面与接口只出现密钥掩码。

**本阶段不做**：工具与工具包挂载编辑（U9 剩余）、配置回滚 UI（U15）、用量统计（U13）、密钥加密（U14）、代理设置（U16）。

## 6. S2~S8 要点（阶段粒度）

| 阶段 | 关键交付与验收要点 |
| --- | --- |
| **S2 存储与项目/团队** | `file-store`（原子写/JSONL 追加/列举/watch）、`KeyedLockManager`、project CRUD + 创建向导（`/api/fs/browse` 选目录）、`project.json` 按 data-storage §3、团队实例快照（D16-⑤）与停用/启用（D14-9）。验收：创建项目后目录结构与 §2 一致；同模板第 2 个实例被拒；停用后会话只读、可重新启用（规则 8） |
| **S3 会话与单工调度** | `SessionLogStore`（seq 单调、`segments[]` 轮转、逐行容错）、`SessionMetaStore`、dispatcher `occupancy`/`lastHandledSeq`、消息排队、WS 网关（**先盘后推**）。验收：同时刻一个 Agent 只在一个会话；seq 跨轮转连续（规则 1/5/9） |
| **S4 Agent loop 与工具执行** | `LoopRegistry` + 三策略**真实形态**（`reflective` 真调 critique、`plan-execute` 计划由模型产出并消费、`maxIterations`/`toolBudget` 生效——修正 agent-runtime §3 的"提示级"现状）、`ContextBuilder`（与提示词预览同源）、`ToolRegistry`/`ToolPackageRegistry`/`ToolExecutor` 校验链、`PathResolver`/`PolicyEngine`、`cmd_run` 沙箱与审批桥。验收：Mock 剧本驱动多轮工具调用；越界路径拒绝（规则 2/3/11/26） |
| **S5 记忆与检索** | `MemoryStore`（global/角色）、滚动摘要作为**可重放派生视图**、2-gram 倒排 + `reindex`、`GET /search`。验收：摘要 ofSeq/toSeq 连续无重叠、中文检索命中（规则 6/7/13）。**结果（2026-09-15）**：`memories/*.jsonl` append-only + `supersede` 状态行；滚动摘要阈值 40 条消息、`summary` 事件 `ofSeq/toSeq` 实测 `1~41`（下一条必接其上）；`search-index/index.json` 可删可重建（`npm run reindex`）；中文 2-gram 命中并返回可跳转 `(sessionId, seq)`；`memory_append`/`memory_search`/`session_search` 三工具真实注册；上下文新增 `global-memory`/`role-memory`（+按需 `retrieval`）块 |
| **S6 产出物、任务、询问** | `workdir_edit` + `file-owners` 归属校验、artifact manifest + `artifact-versions`（doc 快照 / code 补丁）+ 回退、任务发布→领取→汇报 + 去重 + 单 `in_progress`、`ask_user` 阻塞与答复续跑、doc 审批托盘。验收：非 owner 写他人文件 `ERR_FORBIDDEN`（规则 4/10/12/15~18/21/24/25）。**结果（2026-09-15）**：写通道唯一化 + 署名（`ERR_FORBIDDEN` 点名 ownerName）；`artifact-versions/<id>/v<n>/{manifest.json,diff.patch,files/,base/}` 与回退冲突前置校验（`force` 覆盖，新版本 `state=reverted`）；未结算改动按 `task-<id>`/`turn-<sid>-<n>` 聚合，任务 done/终止前结算为 `type=code` artifact；任务单 `in_progress`、去重、回报委派人；`ask_user` 落 pending 并阻塞（`waiting` 由 pending 询问派生）。**遗留**：托盘批量同意/信任开关 UI（D17-④）与 `task_assign` 出边约束（S7） |
| **S7 编排画布与前端完整化** | `/api/projects/:pid/orchestration` 全量保存 + `version` 乐观并发 + 自环/重复边校验、Agent 委派**出边约束**（`ERR_ORCHESTRATION_EDGE`）、画布、项目页拓扑 2 栏 / 对话 3 栏、右栏三列表、工作日志折叠与 kind 过滤。验收：越边委派被拒且不建任务（规则 22/23）。**结果（2026-09-15）**：`orchestration.json`（原子写 + 单项目锁）+ `GET` 读取归一化（补节点/级联删边）+ `PUT` 全量保存（`version+1`、冲突 `ERR_CONFLICT` + `detail.currentVersion`、非法图 `ERR_ORCHESTRATION_INVALID`）、`orchestration.updated` 广播；`task_assign` 出边约束（越边不建任务，用户不受限）；前端零依赖 SVG 画布（拖拽/连线/删边/保存/暂停/跳会话）+ 拓扑 2 栏 + 对话 3 栏 + 工作日志折叠与 kind 过滤。**遗留**：停止任务/未完成回合三选与托盘批量审批（S8）；设计候选 React Flow 未引入（P1 选型） |
| **S8 恢复、运行控制与收口** | 未完成回合横幅三选（缺 `turn_end`）、排队消息恢复、暂停/停止（未结算改动先结算快照）、"停止生成"、进行中细条、项目导出 zip。验收：跨重启会话/画布/记忆恢复（规则 14/19/20）。**结果（2026-09-15）**：`RecoveryService` 栈式配对判定未完成回合 + 三选（`report/continue/complete` 唤醒、`ignore` 静默、重复 `ERR_CONFLICT`）；`stop(turn/task)`（停生成保留队列 / 终止任务先结算 code artifact）；`GET /runtime` 细条（占用者 + 任务 + plan 状态 + 未完成回合 + 队列）；零依赖 STORE ZIP 导出运行时项目文件夹（附范围说明、不含工作目录）；启动自检记录未完成回合且**不自动续跑**。**遗留**：导入/恢复向导、流式压缩导出、多进程停止语义（S9 或 P1） |
| **S9 全量验收与文档收口** | 跑通 prd §9 脚本 1~8；`contract.md`/`data-storage.md`/`testing/plan.md` 按实现回写；覆盖率门禁达标；`README.md` 编号索引同步。**结果（2026-09-15）**：`tests/acceptance/prd-section9.test.ts` 8/8 通过（脚本化 Mock 网关让委派/唤醒/提问/审批真的经过 agent loop）；全量 44 files / 302 tests 全绿；`npm run coverage` 触达门禁 141/141；验收暴露并修复 4 个缺陷（调度态读改写、模板工具白名单、`GET /api/config`、死代码）；文档与索引已回写 |
| **S10 移除 mock 与 Agent 默认不配置模型** | 彻底删除 mock（`ProviderKind` 收敛四种、删 `providers/mock.ts` 与注册、预置目录 9 家、校验不再豁免）、8 个内置角色 `defaultModel` 置空、出厂不再自动创建供应商/模型、`MODELS__DEFAULT` 改为初始化阶段生效、启动迁移未知 kind 并写审计、测试替身下沉 `tests/`。**结果（2026-09-16）**：`tests/acceptance/prd-section9.test.ts` 按新口径 8/8（脚本 2 改为"未配置模型 → `ERR_MODEL` + 引导"）；全量 **45 files / 306 tests 全绿**；`typecheck`/`eslint`/依赖棘轮 0 违规、触达门禁 **140/140**、`vite build` 通过；真实 `data/model-config.json` 已在运行实例上完成迁移（`config-audit.jsonl` 记 `migrate/removedProviders:["mock"]`） |
| **S11 模板库删除/停用与一键配置模型** | 用户模板可删（`confirm` 二次确认 + 被项目实例引用 → `409` + referrers 点名）、内置模板只能停用且停用/默认模型写 `data/agent-templates-state.json` 覆盖（仓库 yaml 只读、重启不丢）、`POST /api/agent-templates/bulk-model` 批量写默认模型、`overview.unconfiguredAgents` 计数 + 模型模块一键设全局默认、Agent 模块多选/删除/配置交互。**结果（2026-09-16）**：全量 **46 files / 311 tests 全绿**（新增 `s11-template-delete-bulk.test.ts` 5 例）；`coverage` 触达门禁 **141/141**；`typecheck`/`eslint`/依赖棘轮 0 违规、`vite build` 通过；修复 1 个真实缺陷（`team-service` 未走完整回退链，靠全局默认生效的实例被误标"模型不可用"） |
| **S12 工具模块瘦身** | 「工具」模块只保留工具包表格，包内工具改为「详情」弹窗查看（工具名/状态已注册｜未实现/说明/风险/需审批/幂等），移除**已注册工具表格**与 **agent loop 策略列表**；后端 `/api/tool-packages`、`/api/tools`、`/api/loops` 契约不变。**结果（2026-09-16）**：`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物不再含 `agent loop 策略` 文案、含 `工具包详情`；全量测试与门禁保持全绿（本轮无后端改动） |
| **S13 `ask_user` 独立为交互包** | `ask_user` 从 `task` 包移出，独立为 `interaction`（交互）基础包（基础包 7 → 8，仍全员必选）；工具注册 `package` 与包声明双向一致（新增 `tool-packages-api.test.ts`）；8 个角色模板同步挂载；包不参与运行期授权 → 既有项目无需迁移。**结果（2026-09-16）**：全量 **47 files / 314 tests 全绿**；`typecheck`/`eslint`/依赖棘轮 0 违规、`coverage` 与 `vite build` 通过；活体确认 `/api/tool-packages` 8 个包且 `interaction` 已注册 |
| **S14 删除「默认路由」功能** | 移除 `ModelRouting`（`defaultModelId`+`stepOverrides`）全链路：端口/存储/校验/DTO/服务/`GET,PUT /api/model-routing`/前端「默认路由」卡片与「设为全局默认」；`overview` 去掉 `routing`；`/api/config` 去掉 `models.defaultModelId`；`.env` 的 `MODELS__DEFAULT` 删除；生效链收敛为 `实例覆盖 → 模板快照 → ERR_MODEL`；遗留 `routing` 键启动抹掉 + 审计。**结果（2026-09-16）**：全量 **47 files / 314 tests 全绿**（新增/改写 S14 相关用例与规则 33）；`typecheck`/`eslint`/依赖棘轮 0 违规、`coverage` 触达 141/141、`vite build` 通过；活体确认真实 `data/model-config.json` 的 `routing` 键被清除且审计 `removed:["routing"]` |

## 7. 每阶段完成定义（DoD，缺一不算完成）

1. **测试**：`npm run test` 全绿；本阶段覆盖的 `testing/plan.md` 规则逐条有对应用例（正常/边界/非法/异常）。
2. **门禁**：`npm run lint` 通过（六层依赖 + ratchet 无新增违规）；`domain`/`ports` 不出现 `node:*`。
3. **契约**：新增/改变的 REST、WS、事件 kind、错误码已回写 `contract.md`；新增事件已登记 `domain/events`（D18-⑤d 单一事件规范）。
4. **存储**：新增落盘文件/字段已回写 `data-storage.md`（含 `schemaVersion` 与迁移说明）。
5. **留痕**：本阶段 `docs/plan/YYYY-MM-DD-<topic>.md` 与 `docs/changes/YYYY-MM-DD-<topic>.md` 已写，改动可追溯。
6. **可演示**：本阶段有可手工走通的验收路径（Mock 模型可离线完成）。

## 8. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 门禁未先行，越层 import 扩散 | 返工成本高 | **S0 必须先于一切业务代码**；ratchet 只减不增 |
| `agent-runtime.md` §3 三策略目前是"提示级" | 用户配置的 loop 参数（`maxIterations` 等）无实际效果 | S4 明确列为交付项：策略真实化 + 参数消费者 + 测试；在 S4 前 UI 对 loop 参数标注"待 S4 生效" |
| 单工调度与跨重启恢复最复杂 | S3/S8 易反复 | 先纯函数状态机 + InMemory 替身测试，再接文件存储；恢复场景全部以"缺 `turn_end`"为判定依据 |
| 模型适配器协议差异（5 种 + SSE/NDJSON） | 流式归一化易出错 | 适配器层**契约测试**（真实/替身同套断言）；S1 先 Mock/Ollama 离线跑通，再连真实供应商 |
| 密钥泄露（日志/审计/错误体） | 安全事故 | 脱敏装饰器统一出口 + 规则 28 用例；代码评审检查任何新增日志点 |
| 编排图乐观并发 | 画布保存丢更新 | `version` 校验 + 单项目串行锁；失败提示刷新重试 |
| 工程脚手架重建（`package.json` 等已被清空） | S0 阻塞 | S0 内一次建成并锁定依赖版本；不引入新重型依赖（abstraction §5.1） |
| 行尾 CRLF/LF 混用（现有 `.gitattributes` 缺失） | diff 噪音 | 可选：S0 加 `.gitattributes` 统一文本文件行为（需单独决策） |
| 文档与实现漂移 | 设计与代码不一致 | DoD 第 3~4 条强制回写；每阶段 changes 记录与 diff 一一对应 |

## 9. 不在本计划内

- `U8` 自定义工具包制作/安装/信任、`U10` 通用领域场景（`general` 模板集）、`U11` 第三方 / MCP 式外部工具接入、`U12` 下游向上游主动沟通；
- `U9 剩余`（工具与工具包挂载编辑、配置回滚 UI）、`U13` 用量与费用统计、`U14` 密钥加密与钥匙串、`U15` 配置版本回滚、`U16` 网络代理与自签证书；
- P1/P2 需求（`FR-15`~`FR-19`、`FR-21`~`FR-24`）：diff 预览、会话打断控制、向量检索、多项目并发、云端与账号；
- 深色主题与 i18n。

## 10. 进度记录方式

- **阶段开始时**：写该阶段的 `docs/plan/YYYY-MM-DD-<topic>.md`（范围、步骤、关键伪代码、验证方式、不在范围）。
- **阶段结束时**：写 `docs/changes/YYYY-MM-DD-<topic>.md`（交付内容、逐文件改动、关键决定、验证结果、未做、回滚），并更新本文件第 3 节表格的"状态"列（`未开始 / 进行中 / 已完成`，附对应 plan/changes 文件名）。
- **阶段状态列**：S0~S9 当前均为「未开始」（2026-09-15 建计划时仓库无实现代码）。
