# 文档总览 · Agent Haness

> 类别：index · 状态：草稿(待评审) · 日期：2026-09-14（2026-09-15 增补 model-config.md 与术语/编号索引）
> 本文件是文档体系的入口：文档地图、术语表、编号索引。改动文档时请同步维护此处。

## 1. 文档地图

| 目录 | 作用 | 文件 |
| --- | --- | --- |
| `docs/requirements/` | 需求真源（目标/用户故事/功能需求/决策/边界/验收） | [prd.md](requirements/prd.md) |
| `docs/design/` | 设计真源（架构、抽象与端口、运行时、存储、工具、沙箱、编排、UI …） | [architecture.md](design/architecture.md)、[abstraction.md](design/abstraction.md)（代码抽象/端口/DI）、[agent-runtime.md](design/agent-runtime.md)、[model-config.md](design/model-config.md)（**模型配置与 Agent 配置提交**）、[sessions.md](design/sessions.md)、[data-storage.md](design/data-storage.md)、[memory.md](design/memory.md)、[tools.md](design/tools.md)、[tool-packages.md](design/tool-packages.md)、[agent-templates.md](design/agent-templates.md)（Agent 与场景）、[orchestration.md](design/orchestration.md)、[sandbox.md](design/sandbox.md)、[workspaces-artifacts.md](design/workspaces-artifacts.md)、[ui.md](design/ui.md) |
| `docs/api/` | 接口约定（REST + WS + 错误码） | [contract.md](api/contract.md) |
| `docs/testing/` | 测试计划（分层、规则清单、门禁） | [plan.md](testing/plan.md) |
| `docs/operations/` | 部署与运维（本机部署、配置、备份迁移） | [deploy.md](operations/deploy.md) |
| `docs/plan/` | 开发方案（改动前必写，按日期命名）；**总计划** [development.md](plan/development.md)（`S0`~`S9` 阶段划分、依赖、验收、风险） | `development.md`、`YYYY-MM-DD-<topic>.md` |
| `docs/changes/` | 修改记录（每次改动追加，与 diff 一一对应） | `YYYY-MM-DD-<topic>.md` |

**阅读顺序建议**：`prd.md` → `architecture.md` → `abstraction.md`（抽象/端口/DI）→ `agent-runtime.md` / `sessions.md` → `orchestration.md` / `tools.md` / `tool-packages.md` / `agent-templates.md` / `model-config.md`（模型与 Agent 配置）→ `data-storage.md` / `memory.md` → `ui.md` / `contract.md` → `testing/plan.md` / `operations/deploy.md` → **`plan/development.md`（编码阶段执行顺序）**。
**改动流程**：先写 `docs/plan/` 方案 → 改文档 → 追加 `docs/changes/` 记录 → 复核链接与术语（见 `prd` §9）。

## 2. 术语表

| 术语 | 含义 |
| --- | --- |
| 项目（Project） | 一次软件开发任务：= 运行时项目文件夹（配置/会话/记忆/manifest…）+ 用户选定的**项目工作目录** |
| 工作目录（workdir） | 用户创建项目时选定的目录；**全部产出的唯一落地处**，目录内容**全员可读**，写入按文件归属校验 |
| 期望产出物 Artifact | 产出物的登记记录（署名/类型/文件清单/摘要/版本），可回退 |
| 角色模板 / Agent 模板 | 系统库中的角色定义（提示词/默认 loop/默认模型/默认工具/场景标签），只读，可从内置复制新建 |
| 角色实例 / Agent 实例 | 项目内从模板快照派生的成员（`instanceId` 如 `pm_1`），承载会话、记忆、任务 |
| 场景（scenario） | Agent 模板的领域标签：`software`（现成 8 个软件团队模板）、`general`（**预留**） |
| Agent loop | 单次处理的执行编排模板（`direct` / `reflective` / `plan-execute`） |
| 工具包（tool package） | 一组同域工具的集合（如 `fs`/`cmd`/`memory`…）；MVP 的 7 个包全员必选 |
| 会话（Session） | 用户与单个 Agent 的 1:1 交流容器（MVP 只有 `user` 类型），也是记忆边界单位 |
| 编排图（orchestration） | 项目级有向图：节点 = Agent 实例卡片，边 = "可创建/委派任务"的关系 |
| 委派（delegate） | 上游 Agent 沿**出边**向目标 Agent 创建并发布任务 |
| 汇报（report） | 受派 Agent 沿**同一条边的反向**回传任务完成/受阻结果（系统行为，不算越权） |
| 领取（claim） | 受派 Agent 把任务从 `todo` 置为 `in_progress` 并开工；每 Agent 至多 1 个 `in_progress` |
| 询问（question） | Agent 向用户提问并**阻塞等待**答复（Agent 状态 `waiting`），在右栏"询问列表"处理 |
| 审批（approval） | 高危命令 / 按策略的提交需用户批准；与询问并列的另一种阻塞来源 |
| 暂停 / 停止 | Agent 级运行控制：暂停=不再领新活、当前回合到可中断点挂起；停止=终止当前任务（先结算未完成改动） |
| 单工（single-tasking） | 一个 Agent 同一时刻至多一个活动会话（`working`/`waiting` 均占用） |
| 先盘后推 | 事件先落 session log 再推 WS（流式文本例外，见 `memory.md` §2） |
| 端口 / 适配器（Port / Adapter） | 跨层契约（接口 + DTO）与其实现：业务只依赖端口，IO 实现放 `infra/`（见 `abstraction.md` §2/§4） |
| 组合根（Composition Root） | 进程内唯一的依赖装配处（`bootstrap/composition-root.ts`），启动期暴露缺失依赖 |
| 依赖注入（DI）/ Token / 作用域 | 构造器注入 + `Token<T>` 标识；生命周期 `singleton/scoped/transient`（见 `abstraction.md` §5） |
| 有效配置（EffectiveAgentConfig） | 每回合解析出的实例配置（模板快照→实例覆盖→项目策略→平台默认）；作为参数传入，不进容器 |
| 模型供应商（Provider） | 一次模型服务连接：协议 kind + baseUrl + 凭证（+启用/超时）；UI 可增删改，落 `data/model-config.json`（见 model-config.md §3） |
| 模型条目（Model） | 供应商下的一个具体模型（id/真实模型名/能力/上下文/默认参数）；Agent 的 `model` 字段引用它（见 model-config.md §4） |
| 协议 kind（适配器） | 与供应商对接的代码级协议实现：`openai-compatible` / `anthropic` / `gemini` / `ollama` / `mock`（见 model-config.md §6） |
| 配置审计（config-audit） | `data/config-audit.jsonl`：平台/模板/实例配置变更的 append-only 留痕（不含密钥明文与提示词全文，见 model-config.md §10） |

| 未完成回合（unfinished turn） | 事件流中**缺 `turn_end`** 的回合；平台不自动续跑，由用户三选（汇报中断点/继续执行/忽略）或补全驱动恢复 |
| 归属与署名（file-owners） | 工作目录文件的 owner 与 `ownerName`（署名）；非 owner 写入 → `ERR_FORBIDDEN`，无主文件首写即认领 |
| 滚动摘要（L2） | 会话 log 的 `summary` 事件：`ofSeq/toSeq` 连续无重叠，替代更早的原文窗口（可重放派生视图） |
| 长期条目（L3） | `memories/global.jsonl` 与 `memories/<instanceId>.jsonl` 的跨会话知识条目（active/superseded） |
| 运行细条 | 顶部「n 个 Agent 正在工作」：占用者 + 当前任务 + 最近 `plan` 状态 + 队列，可停止生成/停止任务 |
| 触达门禁 | `npm run coverage`：测试 → 传递 import 图可达性检查（替代行覆盖率工具链） |

## 3. 编号索引

### 3.1 需求与用户故事

- 用户故事 `US-1`~`US-23`；功能需求 `FR-01`~`FR-35`（P0/P1/P2 分级见 `prd` §5）。
- **编号不复用**：条目删除后保留空缺，并在列表处标注原因（现有空缺：US-5/US-6、FR-09/FR-20，均为 2026-09-14 移除会议功能所致）。
- 2026-09-15 增补：`US-22`（模型供应商配置）、`US-23`（Agent 配置提交）、`FR-34`（模型配置模块）、`FR-35`（Agent 配置提交）。

### 3.2 决策编号（`prd` §7）

- `D1`~`D20` 为需求/设计决策记录；条内子项写作 `D14-③`、`D20-⑧` 形式。
- 空缺（如 `D2`、`D14-⑤/⑥/⑩`、`D16-①`、`D17-②/③`、`D18-①`）表示该决策已随会议功能移除被删除。
- `A1~A6`、`B1/B4/B5/B6/B8/B12`、`H2/H3/H4`、`M1~M14`、`R1~R6` 是历史评审/里程碑/重构轮次的编号，出处（原 `docs/changes/*`）已随重启提交删除；正文仅在需要追溯时引用，新增文档**不要**再引入这些编号。

### 3.3 未决清单（`prd` §10）

- `U1` 平台与项目代号命名；`U8` 自定义工具包（制作/安装/信任）；`U10` 通用领域场景扩展；`U11` 第三方 / MCP 式外部工具接入；`U12` 下游向上游主动沟通是否放开。
- `U9` Agent 配置提交**已部分收敛**（2026-09-15 D20-⑧）：提示词 / loop / 模型三项定案；**剩余**=工具与工具包挂载编辑、配置回滚交互。
- 2026-09-15 新增：`U13` 模型用量与费用统计；`U14` 密钥加密与系统钥匙串；`U15` 配置版本回滚；`U16` 网络代理与自签证书。
- 历史 `U2~U7` 已定案或随会议功能移除；编号不复用。

### 3.4 阶段编号（`S0`~`S9`，`plan/development.md` §6）

| 阶段 | 主题 | 方案 / 记录 |
| --- | --- | --- |
| `S0` | 工程脚手架与依赖门禁 | [plan](plan/2026-09-15-s0-scaffold.md) · [changes](changes/2026-09-15-s0-scaffold.md) |
| `S1` | 模型配置模块 + Agent 配置提交 | [plan](plan/2026-09-15-s1-model-config.md) · [changes](changes/2026-09-15-s1-model-config.md) |
| `S2` | 存储底座与项目/团队 | [plan](plan/2026-09-15-s2-project-team.md) · [changes](changes/2026-09-15-s2-project-team.md) |
| `S3` | 会话与单工调度 | [plan](plan/2026-09-15-s3-sessions-dispatcher.md) · [changes](changes/2026-09-15-s3-sessions-dispatcher.md) |
| `S4` | Agent loop 与工具执行 | [plan](plan/2026-09-15-s4-agent-loop-tools.md) · [changes](changes/2026-09-15-s4-agent-loop-tools.md) |
| `S5` | 记忆与检索 | [plan](plan/2026-09-15-s5-memory-search.md) · [changes](changes/2026-09-15-s5-memory-search.md) |
| `S6` | 产出物、任务、询问 | [plan](plan/2026-09-15-s6-work-artifacts-tasks.md) · [changes](changes/2026-09-15-s6-work-artifacts-tasks.md) |
| `S7` | 编排画布与前端完整化 | [plan](plan/2026-09-15-s7-orchestration-ui.md) · [changes](changes/2026-09-15-s7-orchestration-ui.md) |
| `S8` | 恢复、运行控制与收口 | [plan](plan/2026-09-15-s8-recovery-runtime.md) · [changes](changes/2026-09-15-s8-recovery-runtime.md) |
| `S9` | 全量验收与文档收口 | [plan](plan/2026-09-15-s9-acceptance-closure.md) · [changes](changes/2026-09-15-s9-acceptance-closure.md) |

- **测试规则编号**（`testing/plan.md` §2，共 31 条）与**规则→用例映射**（§5）配套使用；验收脚本 1~8 见 `prd` §9，可执行套件在 `tests/acceptance/prd-section9.test.ts`。
- 覆盖率门禁：`npm run coverage`（文件级触达；口径见 `testing/plan.md` §4）。

## 4. 维护约定

1. 新增文档必须在本文件 §1 登记，并放入对应类别目录。
2. 每次改动先写 `docs/plan/` 方案、后写 `docs/changes/` 记录（标准见项目开发规范）。
3. 术语以本文件 §2 为准；同一概念不得在其它文档换词（例：不写"工作空间"表示私有区、不写"会议""拍板"表示已删除机制）。
4. 跨文档引用一律用相对路径 Markdown 链接；改文件名时同步修正引用。
