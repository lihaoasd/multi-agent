# 修改记录 · 模型配置模块 + Agent 配置（模型 / loop / 提示词）（2026-09-15）

> 类别：changes · 类型：设计（非实现）· 方案：[docs/plan/2026-09-15-model-config-module.md](../plan/2026-09-15-model-config-module.md)
> 需求来源：用户"设计一个配置模型的模块，用户可添加各个常见供应商，agent 中需要配置模型，agent-loop，提示词"

## 1. 交付内容

新增 **`docs/design/model-config.md`**——模型配置与 Agent 配置提交的设计真源，共 14 节：

| 节 | 内容 |
| --- | --- |
| §1 定位与边界 | 只配置不执行；本机单用户无授权链，唯一硬约束是密钥不得出现在读路径 |
| §2 配置分层与解析链 | 平台（`data/model-config.json`）→ 模板 → 实例；解析链 `实例 → 模板 → loop 步骤默认 → 平台默认`；**失败不回退他模型** |
| §3 供应商（Provider） | `{id,name,kind,baseUrl,credential,headers,enabled,timeoutMs,presetId}`；一家可多条连接 |
| §4 模型条目（Model） | `{id,providerId,model,displayName,capabilities,contextWindow,maxOutputTokens,defaultParams,enabled}` |
| §5 凭证与安全 | `file`/`env` 双模式；读路径只回 `hasValue`/`masked`；脱敏装饰器；审计不记明文 |
| §6 适配器 kind 与预置目录 | 5 种 kind（`openai-compatible`/`anthropic`/`gemini`/`ollama`/`mock`）的端点/认证/流式差异表 + 9 家预置目录 + 自定义 |
| §7 连通性测试与模型发现 | `test`（`models`/`chat` 两模式）、`discover`、`bulk` 批量登记；测试不写会话日志 |
| §8 校验规则与失败语义 | 15 条规则，**不新增错误码**（沿用 `ERR_VALIDATION`/`ERR_CONFLICT`/`ERR_NOT_FOUND`/`ERR_FORBIDDEN`/`ERR_MODEL`，引用者放 `detail.referrers`） |
| §9 生效时机与缓存失效 | 7 行"改什么 → 何时生效 → 是否重启"表；机制只有"原子写 + `ModelCatalog.invalidate()`" |
| §10 审计与留痕 | `data/config-audit.jsonl` + `data/roles/<roleId>.history/` 快照；不含密钥明文与提示词全文 |
| §11 `.env` 关系、迁移与兼容 | `.env` 降为引导与边界默认（5 个键）；遗留 `MODELS__PROVIDERS`/旧 `model-config.json`/`agent-models.json` 三种兼容策略 |
| §12 端口与代码落点 | `ModelConfigStore`/`ProviderKindAdapter`/`ProviderKindRegistry`/`ModelCatalog`/`ModelConfigService`/`AgentConfigService` + 预置目录文件 |
| §13 契约摘要 | REST/WS/错误码一览，指向 contract.md |
| §14 未决与后续 | U9 剩余、U13 用量费用、U14 密钥加密、U15 配置回滚、U16 代理与自签证书 |

## 2. 修订文件

| 文件 | 改动 |
| --- | --- |
| `docs/requirements/prd.md` | 新增 **US-22/US-23、FR-34/FR-35、决策 D20**；修订 FR-10（五适配器）、FR-25（四模块）、FR-27（三项可提交）、US-16；§6 补"凭证安全"行；§8 补 3 条不做事项；§9 补验收 8；§10 U9 标注部分收敛并新增 U13~U16；§7 加"D19-①③已由 D20 修订"说明 |
| `docs/api/contract.md` | 新增"模型配置"端点组（15 个端点）；**删除** `GET/PUT /api/settings/models（config.yaml 落盘）`（缺陷 C1 收口）；Agent 模板写路径（POST/PATCH/disable）；`/api/roles` 标为废弃别名（术语收敛）；`/api/config` 改为运行期只读总览；WS 增 `model-config.updated`/`agent-config.updated`；`ERR_MODEL` 含义扩写 |
| `docs/design/data-storage.md` | §2 布局增 `model-config.json`、`model-config.v0.bak.json`、`config-audit.jsonl`、`roles/<roleId>.history/`；§3 `team[].model` 语义改为模型条目 id 并新增 `configVersion`；§8 模板可编辑与版本快照；§9 增 2 行恢复策略；`.env` 注释更新 |
| `docs/design/agent-templates.md` | §3 改为"展示与配置字段"（含写路径契约表）；§4 由"MVP 只读/后续"改写为"配置提交（开放三项）"：可配置项与校验、生效范围三条、留痕、本轮不做 |
| `docs/design/agent-runtime.md` | §5 模型路由按 D20 重写：解析链固定四层、`model` 引用模型条目 id、失败语义（不静默换模型）、五 kind 归一化、生效时机；header 增 model-config 关联 |
| `docs/design/abstraction.md` | §4.2 模型类端口重写（+`ModelConfigStore`/`ModelCatalog`，`ModelProvider`→`ProviderKindAdapter`、`ProviderRegistry`→`ProviderKindRegistry`）；§4.6 新增 `ports/model-config.ts` 签名、`ModelRequest.model: ModelId`、`EffectiveAgentConfig.model: ModelId`；§5.4 组合根样例更新；§5.5 生效表增 3 行与平台模型配置时序；§7 扩展手册拆为"新增协议 kind / 新增预置供应商"两行；§8 目录增 `model-config/`；§12 演进路线增 D20 行、U9 行标注；§1 与 §13 未决措辞同步 |
| `docs/design/architecture.md` | §2 模型 Provider（五种 kind）与配置来源；§4 模块树增 `application/model-config/`、`infra/model` 注释更新；§9 扩展点；§10 REST 清单（`/api/roles` 取消、增模型配置）；§11 页面表增模型模块、Agent 模块改可提交 |
| `docs/design/ui.md` | §1 信息架构 → 四模块（增"模型"）；§2 标题改四模块；§2.2 Agent 模块改可编辑（三项 + 仍只读说明 + 实例覆盖）；新增 **§2.3 模型模块**（供应商/模型条目/默认路由/安全提示/失败文案/空态）；§2.4 工具模块（原 2.3）；§6 增 2 行交互约定与空态文案；§7 接口对应增 2 行；§8 P1 增模型相关 |
| `docs/design/tool-packages.md` | §5 的 UI 引用由错误的 `ui.md §3` 修正为 `§2.4（工具模块）` |
| `docs/operations/deploy.md` | §1 模型后端改为五 kind + UI 配置；§3 标题与正文改为"`.env` + 运行时模型配置"（模型配置不进 `.env`、改完即时生效），常用键替换为 `MODELS__CONFIG_FILE/DEFAULT/IMPORT_FROM_ENV/REQUEST_TIMEOUT_MS/MAX_PROMPT_CHARS`，密钥存放口径双模式化；§4 备份表增模型配置与审计、roles 历史；§5 常见问题指向[测试连接] |
| `docs/testing/plan.md` | 新增规则 **27~31**（模型配置校验与引用保护、凭证不外泄、Agent 配置提交与生效、不静默换模型、适配器归一化）；header 增设计依据链接 |
| `docs/README.md` | §1 文档地图登记 `model-config.md`、阅读顺序插入；§2 术语表增 5 条（模型供应商/模型条目/协议 kind/配置审计，及有效配置行）；§3.1 编号扩到 US-23/FR-35 并标注增补；§3.2 扩到 D20、补子项写法示例；§3.3 U9 部分收敛 + U13~U16；header 日期补注 |
| `docs/plan/2026-09-15-model-config-module.md` | 新建：本次方案 |
| `docs/changes/2026-09-15-model-config-module.md` | 新建：本记录 |

## 3. 关键决定（可推翻）

1. **供应商与模型条目分层**（D20-①）：`model` 字段从"引用 provider id"改为"引用模型条目 id"。原口径下一个供应商只能挂一个模型，撑不住"添加常见供应商"；兼容旧值与遗留文件见 model-config §11（**不静默改写配置**）。
2. **适配器 kind 由 3 扩到 5**（D20-②）：Anthropic 与 Gemini 不是 OpenAI 兼容协议，必须有原生适配；差异全部收敛在 `infra/model/providers/`，`ModelChunk` 及以上不动。
3. **保留 `ollama` 与 `mock`**：用户预置勾选里没有这两项，但 prd §6 与 §9 验收 2 要求"无 Key 可跑通全流程"，删除会破坏既有验收，故保留并在文档中显式标注该偏离（model-config §6.2、plan §1）。自定义供应商不单列预置卡片——"新增供应商"入口本身支持手填 kind/baseUrl。
4. **凭证双模式 + 读路径永不含明文**（D20-④）：`file` 明文落 `data/model-config.json`（`data/` 已 gitignore）或 `env` 只存变量名；不引加密依赖（U14 留后续）。
5. **配置落 `data/model-config.json` 并即时生效**（D20-⑤）：`.env` 从"模型配置唯一来源"降为引导与边界默认；这是对 `deploy.md` 原文"配置唯一来源是 `.env`"的修订，同步改了该文件与 `data-storage.md`。
6. **解析失败不回退他模型**（D20-⑥）：宁可报 `ERR_MODEL`，也不"悄悄换模型"。
7. **两层配置 + 快照语义**（D20-⑦）：模板编辑只影响未来新建实例（沿用 D16-⑤），实例覆盖下一回合生效、运行中回合到可中断点；本轮只开放提示词/loop/模型三项，工具挂载留 U9 剩余（D20-⑧）。
8. **术语收敛**：模板读写入口统一 `/api/agent-templates`，`/api/roles` 标为废弃别名；`ModelProvider`/`ProviderRegistry` 更名以避开"用户配置的供应商"歧义。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 文档链接 | 全库 29 份文档、169 条相对链接，**0 断链**（脚本逐条 `Test-Path` 校验） |
| 旧口径残留 | 全库搜 `settings/models`/`config.yaml`/`MVP 只读`/`config.models.providers`/`provider id`/`MODELS__DEFAULT`：**设计真源 0 处旧说法**；仅存于历史 `plan`/`changes`（不改）与本文档"迁移/兼容"处（有意保留） |
| 设计内交叉引用 | `model-config.md` 被 agent-templates/agent-runtime/data-storage/abstraction/architecture/ui/contract/deploy/testing/README 引用；其 §2/§3~§4/§5/§6/§8/§9/§10/§11/§12 被引用的节号均存在；`§8 #13/#14/#15` 对应提示词/loop/内置模板三行 |
| 端口口径一致 | `EffectiveAgentConfig.model` 与 `ModelRequest.model` 均为 `ModelId`；新增端口在 model-config §12 与 abstraction §4.2/§4.6 一一对应 |
| 编号记账 | US-22/23、FR-34/35、D20、U13~U16 均已登记 prd 与 README；U9 标注"部分收敛 + 剩余"，未复用编号 |
| 编辑事故复核 | 修改 PRD §7 时一次编辑误删 D19 表头（D20 行前插），已即时修复并按行复核：D19 完整于 141 行、D20 于 142 行，§7 决策行序 D14→D15→D16→D17→D18→D19→D20 正确 |

## 5. 未做（另开一轮）

- 不创建任何 `src/`/`tests/` 代码（含接口骨架、预设 YAML 文件）——交付形态经用户确认；
- 不做自定义 loop 策略插件、提示词占位符语法、配置回滚 UI、工具挂载编辑、密钥加密、用量费用统计；
- 未处理 `agent-runtime.md` §3 的"实现现状"标注：它描述的是已被 `0217e21` 清空的旧代码，属文档清理遗留；
- 未修 `prd.md` §9 验收 5 中指向不存在的 `docs/plan/development.md`（既有缺陷，与本需求无关，已记录待清）；
- 未改动历史文档 `docs/plan/2026-09-14-docs-reconciliation.md`（其"口径 9 实例配置 MVP 只读"与 `U-D4` 已被 D20 取代，保留原文以维持历史可追溯）；
- 未同步 `.env.example`（仓库根当前不存在该文件，属实现阶段任务）。

## 6. 回滚

本轮改动共 **15 个文件**（3 新增 + 12 修订，含 `tool-packages.md` 一处引用修正）：

```bash
git rm docs/design/model-config.md docs/plan/2026-09-15-model-config-module.md docs/changes/2026-09-15-model-config-module.md
git checkout HEAD -- docs/README.md docs/requirements/prd.md docs/api/contract.md \
  docs/design/{data-storage,agent-templates,agent-runtime,abstraction,architecture,ui,tool-packages}.md \
  docs/operations/deploy.md docs/testing/plan.md
```
