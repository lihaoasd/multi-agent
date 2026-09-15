# 开发方案 · 模型配置模块 + Agent 配置（模型 / loop / 提示词）

> 类别：plan · 状态：已完成（2026-09-15）· 类型：设计（非实现）· 执行结果见 [修改记录](../changes/2026-09-15-model-config-module.md)
> 关联：[model-config.md](../design/model-config.md)（本次交付物）、[agent-templates.md](../design/agent-templates.md)、[agent-runtime.md](../design/agent-runtime.md) §5、[abstraction.md](../design/abstraction.md) §4.2/§5.5/§7、[prd.md](../requirements/prd.md)

## 1. 需求

用户要求：**设计一个配置模型的模块，用户可添加各个常见供应商；Agent 中需要配置模型、agent-loop、提示词。**

澄清结论（2026-09-15）：

| 议题 | 结论 |
| --- | --- |
| 交付形态 | **仅设计文档**（不创建 `src/` 代码）——2026-09-15 用户确认；提交时仓库无任何实现代码（`0217e21` 已清空旧实现） |
| 预置供应商 | **DeepSeek / OpenAI / Anthropic Claude / Google Gemini / 阿里通义千问（百炼）/ 月之暗面 Kimi / 智谱 GLM / 火山方舟 豆包 / Ollama（本地）** 共 9 家 |
| 自定义与 Mock | 预置清单之外的供应商经"自定义"入口创建（kind + baseUrl 手填）；**保留 `mock` 适配器**——既有 prd §6/§9 要求"无 Key 可跑通全流程"，本模块不得破坏该验收 |
| 配置生效范围 | **两层都配**：首页 Agent 模块编辑系统模板；项目内实例可覆盖（沿用 D16-⑤ 快照口径） |
| 可配置项 | 本轮开放 **模型 / agent-loop / 提示词** 三项；工具与工具包挂载仍只读（U9 剩余部分） |

## 2. 方案要点

1. **供应商与模型条目分层**（本模块核心）。现状口径是"`model` 字段引用 provider id，具体模型名由 provider 内部指定"（agent-runtime §5，B8 定稿），等于一个供应商只能挂一个模型；而"添加常见供应商"必然要求一家多模型。改为：
   - **供应商（provider）** = 一次连接配置（`kind` + `baseUrl` + 凭证），由 UI 增删改；
   - **模型条目（model）** = 供应商下的一个具体模型（真实模型名/能力/上下文/默认参数），全局唯一 id；
   - Agent 的 `model` 字段语义修订为**引用模型条目 id**（旧值"provider id"按单模型供应商兼容解析，见 model-config §11）。
2. **适配器 kind 从 3 种扩到 5 种**：`openai-compatible`（DeepSeek/OpenAI/百炼兼容模式/Kimi/GLM/火山方舟/自定义）、`anthropic`（原生 Messages API）、`gemini`（原生 generateContent）、`ollama`、`mock`。差异（认证头、SSE/NDJSON 形态、工具调用结构）全部在适配器内归一化为既有 `ModelChunk`，`ModelGateway` 及以上不动。
3. **凭证双模式 + 读接口永不回传明文**：`credential.mode = file`（存 `data/model-config.json`，`data/` 已 gitignore）或 `env`（只存变量名）；列表/详情接口只回 `hasValue` 与掩码；审计与日志统一脱敏。
4. **配置落 `data/model-config.json`，即时生效**：UI 改动写盘后失效 `ModelCatalog` 缓存，**不重建容器、不重启**（对齐 abstraction §5.5 动态配置三约束）；只有换适配器实现/换配置路径才需重启。`.env` 从"模型配置唯一来源"降为**引导与边界默认**（配置路径、首次默认模型、遗留导入开关、超时上限）。
5. **两层配置与生效边界**：模板编辑只影响**未来新建实例**（快照，D16-⑤）；实例覆盖在**下一回合开始**生效（`EffectiveAgentConfigResolver.invalidate`），运行中回合到可中断点；两者都留审计。
6. **校验前置且不留暗坑**：id/kind/baseUrl/凭证/引用完整性逐项校验；删除被引用的供应商或模型一律 `ERR_CONFLICT` 并点名引用者；Agent 引用的模型被移除时**不静默回退**到默认模型，而是解析失败报 `ERR_MODEL`，避免"悄悄换模型"。
7. **收口既有缺陷**：删除 `contract.md` 中 `GET/PUT /api/settings/models（config.yaml 落盘）` 这条与"`.env` 是配置唯一来源"冲突的残留口径（P0-7/P0-8 之一）。

## 3. 交付物

| 文件 | 改动 |
| --- | --- |
| `docs/design/model-config.md` | **新增**：模块设计真源（配置分层与解析链、供应商/模型条目 schema、凭证与安全、5 种适配器 kind 与 9 家预置目录、连通性测试与模型发现、校验规则、生效时机、审计、迁移兼容、端口落点） |
| `docs/requirements/prd.md` | 新增 US-22/US-23、FR-34/FR-35、决策 D20；修订 FR-10/FR-27；§6 非功能补密钥口径；§9 验收补脚本；§10 未决清单更新 U9 |
| `docs/api/contract.md` | 新增模型配置端点组与 Agent 配置提交端点；修订 `/api/config`；**删除** `settings/models`（config.yaml 残留）；补 WS 事件与错误码 |
| `docs/design/data-storage.md` | §2 布局补 `data/model-config.json`、`data/config-audit.jsonl`、`data/roles/<roleId>.history/`；§3 `model` 字段语义；§8 模板可编辑与版本；§9 兼容处理 |
| `docs/design/agent-templates.md` | §3/§4 从"MVP 只读"升级为"可配置三项"（可配置项/校验/生效范围/留痕），接口表补写路径 |
| `docs/design/agent-runtime.md` | §5 模型路由口径修订（模型条目 + 步骤默认 + 解析链 + 失败语义） |
| `docs/design/abstraction.md` | §4.2 模型类端口（+`ModelConfigStore`/`ModelCatalog`，`ModelProvider` 更名 `ProviderKindAdapter`）；§4.6 签名（`ModelRequest.model: ModelId`）；§5.5 生效表补两行；§7 provider 扩展手册重写；§12 演进路线 U9 行更新 |
| `docs/design/architecture.md` | §2 模型 Provider 选型、§4 `infra/model` 目录、§9 扩展点、§10 端点清单、§11 页面表 |
| `docs/design/ui.md` | §1 信息架构（全局导航增"模型"模块）、§2.2 Agent 模块可编辑、新增 §2.4 模型模块、§7 接口对应 |
| `docs/README.md` | 文档地图登记 `model-config.md`；术语表补 4 条；编号索引（US/FR/D/U）同步 |
| `docs/plan/2026-09-15-model-config-module.md` | 本方案 |
| `docs/changes/2026-09-15-model-config-module.md` | 修改记录 |

## 4. 验证方式

- **口径自洽**：全库搜 `provider id` / `config.yaml` / `settings/models` / "MVP 只读"，确认模型字段语义、配置来源、Agent 模块可编辑性三处新口径无残留旧说法。
- **扩展点闭环**：新增一种供应商 kind / 一家预置供应商，都能落到 model-config §6 与 abstraction §7 的步骤，且"不需要动容器"。
- **动态配置闭环**：每个"用户改什么 → 何时生效 → 是否重启"都有明确答案（model-config §9 + abstraction §5.5 表）。
- **安全口径**：密钥在任何读路径（REST 响应、日志、审计、错误事件、文档示例）都不出现明文。
- **兼容**：旧值（`model` = provider id、`.env` 的 `MODELS__PROVIDERS`、遗留 `data/model-config.json`）都有明确迁移/忽略策略。
- **文档链接**：全库相对链接可解析；术语与 `docs/README.md` §2 一致。

## 5. 不在本次范围

- 不创建 `src/`/`tests/` 代码（含接口骨架）；
- 不做自定义 loop 策略插件（仅保留 `LoopRegistry` 扩展位）、不做提示词占位符模板语法；
- 不做配置版本回滚 UI（本轮只做只增历史快照 + 审计）；
- 不做工具与工具包挂载编辑（U9 剩余）、不做自定义工具包（U8）、不做第三方/MCP 工具（U11）；
- 不做密钥加密/系统钥匙串集成（本机单用户，明文存 `data/` 且不入库）；
- 不处理 `agent-runtime.md` §3 中"实现现状"标注（描述的是已被 `0217e21` 删除的旧代码，属文档清理遗留，另开一轮）。
