# 文档总览 · Agent Haness

> 类别：index · 状态：草稿(待评审) · 日期：2026-09-14
> 本文件是文档体系的入口：文档地图、术语表、编号索引。改动文档时请同步维护此处。

## 1. 文档地图

| 目录 | 作用 | 文件 |
| --- | --- | --- |
| `docs/requirements/` | 需求真源（目标/用户故事/功能需求/决策/边界/验收） | [prd.md](requirements/prd.md) |
| `docs/design/` | 设计真源（架构、抽象与端口、运行时、存储、工具、沙箱、编排、UI …） | [architecture.md](design/architecture.md)、[abstraction.md](design/abstraction.md)（代码抽象/端口/DI）、[agent-runtime.md](design/agent-runtime.md)、[sessions.md](design/sessions.md)、[data-storage.md](design/data-storage.md)、[memory.md](design/memory.md)、[tools.md](design/tools.md)、[tool-packages.md](design/tool-packages.md)、[agent-templates.md](design/agent-templates.md)（Agent 与场景）、[orchestration.md](design/orchestration.md)、[sandbox.md](design/sandbox.md)、[workspaces-artifacts.md](design/workspaces-artifacts.md)、[ui.md](design/ui.md) |
| `docs/api/` | 接口约定（REST + WS + 错误码） | [contract.md](api/contract.md) |
| `docs/testing/` | 测试计划（分层、规则清单、门禁） | [plan.md](testing/plan.md) |
| `docs/operations/` | 部署与运维（本机部署、配置、备份迁移） | [deploy.md](operations/deploy.md) |
| `docs/plan/` | 开发方案（改动前必写，按日期命名） | `YYYY-MM-DD-<topic>.md` |
| `docs/changes/` | 修改记录（每次改动追加，与 diff 一一对应） | `YYYY-MM-DD-<topic>.md` |

**阅读顺序建议**：`prd.md` → `architecture.md` → `abstraction.md`（抽象/端口/DI）→ `agent-runtime.md` / `sessions.md` → `orchestration.md` / `tools.md` / `tool-packages.md` / `agent-templates.md` → `data-storage.md` / `memory.md` → `ui.md` / `contract.md` → `testing/plan.md` / `operations/deploy.md`。
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

## 3. 编号索引

### 3.1 需求与用户故事

- 用户故事 `US-1`~`US-21`；功能需求 `FR-01`~`FR-33`（P0/P1/P2 分级见 `prd` §5）。
- **编号不复用**：条目删除后保留空缺，并在列表处标注原因（现有空缺：US-5/US-6、FR-09/FR-20，均为 2026-09-14 移除会议功能所致）。

### 3.2 决策编号（`prd` §7）

- `D1`~`D19` 为需求/设计决策记录；条内子项写作 `D14-③` 形式。
- 空缺（如 `D2`、`D14-⑤/⑥/⑩`、`D16-①`、`D17-②/③`、`D18-①`）表示该决策已随会议功能移除被删除。
- `A1~A6`、`B1/B4/B5/B6/B8/B12`、`H2/H3/H4`、`M1~M14`、`R1~R6` 是历史评审/里程碑/重构轮次的编号，出处（原 `docs/changes/*`）已随重启提交删除；正文仅在需要追溯时引用，新增文档**不要**再引入这些编号。

### 3.3 未决清单（`prd` §10）

- `U1` 平台与项目代号命名；`U8` 自定义工具包（制作/安装/信任）；`U9` Agent 配置提交；`U10` 通用领域场景扩展；`U11` 第三方 / MCP 式外部工具接入；`U12` 下游向上游主动沟通是否放开。
- 历史 `U2~U7` 已定案或随会议功能移除；编号不复用。

## 4. 维护约定

1. 新增文档必须在本文件 §1 登记，并放入对应类别目录。
2. 每次改动先写 `docs/plan/` 方案、后写 `docs/changes/` 记录（标准见项目开发规范）。
3. 术语以本文件 §2 为准；同一概念不得在其它文档换词（例：不写"工作空间"表示私有区、不写"会议""拍板"表示已删除机制）。
4. 跨文档引用一律用相对路径 Markdown 链接；改文件名时同步修正引用。
