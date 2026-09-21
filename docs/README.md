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
| `docs/plan/` | 开发方案（改动前必写，按日期命名）；**总计划** [development.md](plan/development.md)（`S0`~`S57` 阶段划分、依赖、验收、风险） | `development.md`、`YYYY-MM-DD-<topic>.md` |
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
| 工具包（tool package） | 一组同域工具的集合（如 `fs`/`cmd`/`memory`…）；MVP 的 8 个包全员必选（S13 起含 `interaction`/`ask_user`） |
| 会话（Session） | 用户与单个 Agent 的 1:1 交流容器（MVP 只有 `user` 类型），也是记忆边界单位 |
| 编排图（orchestration） | 项目级有向图：节点 = Agent 实例卡片，边 = "可创建/委派任务"的关系 |
| 委派（delegate） | 上游 Agent 沿**出边**向目标 Agent 创建并发布任务 |
| 汇报（report） | 受派 Agent 沿**同一条边的反向**回传任务完成/终止结果（**S53/D57**：任务不再有"受阻"状态；系统行为，不算越权） |
| 领取（claim） | 受派 Agent 把任务从 `todo` 置为 `in_progress` 并开工；每 Agent 至多 1 个 `in_progress` |
| 询问（question） | Agent 向用户提问并**阻塞等待**答复（Agent 状态 `waiting`），在右栏"询问列表"处理 |
| 审批（approval） | 高危命令需用户批准（**S53/D56**：产出物登记一律免审批）；与询问并列的另一种阻塞来源 |
| 暂停 / 停止 | Agent 级运行控制：暂停=不再领新活、当前回合到可中断点挂起；停止=终止当前任务（先结算未完成改动） |
| 单工（single-tasking） | 一个 Agent 同一时刻至多一个活动会话（`working`/`waiting` 均占用） |
| 先盘后推 | 事件先落 session log 再推 WS（流式文本例外，见 `memory.md` §2） |
| 端口 / 适配器（Port / Adapter） | 跨层契约（接口 + DTO）与其实现：业务只依赖端口，IO 实现放 `infra/`（见 `abstraction.md` §2/§4） |
| 组合根（Composition Root） | 进程内唯一的依赖装配处（`bootstrap/composition-root.ts`），启动期暴露缺失依赖 |
| 依赖注入（DI）/ Token / 作用域 | 构造器注入 + `Token<T>` 标识；生命周期 `singleton/scoped/transient`（见 `abstraction.md` §5） |
| 有效配置（EffectiveAgentConfig） | 每回合解析出的实例配置（实例覆盖 → 模板快照，两级；S14 起无平台默认层）；作为参数传入，不进容器 |
| 模型供应商（Provider） | 一次模型服务连接：协议 kind + baseUrl + 凭证（+启用/超时）；UI 可增删改，落 `data/model-config.json`（见 model-config.md §3） |
| 模型条目（Model） | 供应商下的一个具体模型（id/真实模型名/能力/上下文/默认参数）；Agent 的 `model` 字段引用它（见 model-config.md §4） |
| 协议 kind（适配器） | 与供应商对接的代码级协议实现：`openai-compatible` / `anthropic` / `gemini` / `ollama`（见 model-config.md §6） |
| 配置审计（config-audit） | `data/config-audit.jsonl`：平台/模板/实例配置变更的 append-only 留痕（不含密钥明文与提示词全文，见 model-config.md §10） |

| 未完成回合（unfinished turn） | 事件流中**缺 `turn_end`** 的回合。**S21/D27 起平台不再判定、也不提示**：是否收尾由 Agent 自己查会话事件（工具 `session_recent`）判断，并用 `ask_user` 询问用户怎么处理（不做固定选项） |
| 归属与署名（file-owners） | 工作目录文件的 owner 与 `ownerName`（署名）；非 owner 写入 → `ERR_FORBIDDEN`，无主文件首写即认领 |
| 滚动摘要（L2） | 会话 log 的 `summary` 事件：`ofSeq/toSeq` 连续无重叠，替代更早的原文窗口（可重放派生视图） |
| 长期条目（L3） | `memories/global.jsonl` 与 `memories/<instanceId>.jsonl` 的跨会话知识条目（active/superseded） |
| 运行细条 | **「拓扑」页编排图顶部**的「n 个 Agent 正在工作」：占用者 + 当前任务 + 最近 `plan` 状态 + 队列，可停止生成/停止任务；**无 Agent 在工作时整条不渲染**（S15/D25-③） |
| 触达门禁 | `npm run coverage`：测试 → 传递 import 图可达性检查（替代行覆盖率工具链） |

## 3. 编号索引

### 3.1 需求与用户故事

- 用户故事 `US-1`~`US-23`；功能需求 `FR-01`~`FR-35`（P0/P1/P2 分级见 `prd` §5）。
- **编号不复用**：条目删除后保留空缺，并在列表处标注原因（现有空缺：US-5/US-6、FR-09/FR-20，均为 2026-09-14 移除会议功能所致）。
- 2026-09-15 增补：`US-22`（模型供应商配置）、`US-23`（Agent 配置提交）、`FR-34`（模型配置模块）、`FR-35`（Agent 配置提交）。

### 3.2 决策编号（`prd` §7）

- `D1`~`D61` 为需求/设计决策记录；条内子项写作 `D14-③`、`D20-⑧` 形式。
- 空缺（如 `D2`、`D14-⑤/⑥/⑩`、`D16-①`、`D17-②/③`、`D18-①`）表示该决策已随会议功能移除被删除。
- 2026-09-16 增补 `D21`（移除 mock / Agent 默认不配置模型）、`D22`（模板删除/停用与一键配置模型）、`D23`（`ask_user` 独立为 `interaction` 包）、`D24`（删除「默认路由」）、`D25`（项目详情页瘦身与运行细条归位）、`D26`（编排图双模式与点击缺陷修复）、`D27`（未完成回合改由 Agent 自查与询问）、`D28`（会话流去掉事件筛选与工作日志折叠）、`D29`（对话消息按 Markdown 渲染）、`D30`（基础工具包全员必装强制化）、`D31`（工具结果条目只显示工具名）、`D32`（改用 `react-markdown`+`remark-gfm` 框架渲染，支持 GFM 表格）、`D33`（工具调用参数默认折叠）、`D34`（工具调用文本化/DSML 根因修复与兼容）、`D35`（询问答复入口归位：会话窗口答复，右栏/任务页只提示）、`D36`（询问改为逐题作答 + 卡片左右滑动、攒齐一次提交）、`D37`（会话窗口铺满屏幕并跟随最新消息 + 工具报错显示报错内容）、`D38`（会话窗口新增「详细日志（trace）」视图）、`D39`（任务汇报闭环：汇报通知改为「事实 + 据此继续」+ 委派人上下文注入「我委派出去的任务」）、`D40`（暂停/停止的回合中断语义修复：暂停当场中断且挂起不推进游标、中断落 `state` 事实、停止生成如实反馈）、`D41`（询问等待的状态语义「等待回复中」：`waitingFor` 投影 + 等待态及时刷新 + 三处界面同源）、`D42`（时间显示改用本地时间：trace 与任务列表不再对 UTC 的 ISO 串切片）、`D43`（开启 think：能力标记驱动思考参数、每轮思考落 `thought` 事件并在会话流展示、思考随 assistant 消息回传）、`D44`（思考条目默认折叠，与工具调用参数同一规格）、`D45`（输入框上方的「现在在干什么」等待提示：暂停/等答复/等审批/正在调用工具/模型正在输出/正在思考/排队，空闲不渲染）、`D46`（思考行标出来源步骤 `思考 · 制定计划`，解释"两条连续的思考"）、`D47`（会话流显示计划 `plan` 行：步骤清单 + 进度/结果，作为各步之间可见的分界）、`D48`（审批卡按会话归属显示：谁的审批只出现在谁的窗口，申请者显示中文名）、`D49`（会话相互独立：「发送中」按会话记，给 A 发消息不再卡住 B）、`D50`（修「系统挂了」：嵌套唤醒死锁 + 重启后补处理排队消息 + 无等待者时唤醒审批申请者）、`D51`（实时帧不再每帧触发整页重渲染：帧不进 state + 会话流行级 `memo`）、`D52`（去掉「停止生成」按钮；暂停＝跑完当前这一轮 loop 后停止循环，不切断在途模型调用）、`D53`（按职能派单的「团队与可委派对象」块、每回合可见的「待领取任务」块、doc 产出统一进 `docs/`）、`D54`（会话顶部显示「正在执行的任务」：`/agents` 投影 `currentTask`，各看各的）、`D55`（模型请求超时改为「空闲超时」：长输出不再被总时长砍掉，超时给中文指引）。
- `A1~A6`、`B1/B4/B5/B6/B8/B12`、`H2/H3/H4`、`M1~M14`、`R1~R6` 是历史评审/里程碑/重构轮次的编号，出处（原 `docs/changes/*`）已随重启提交删除；正文仅在需要追溯时引用，新增文档**不要**再引入这些编号。

### 3.3 未决清单（`prd` §10）

- `U1` 平台与项目代号命名；`U8` 自定义工具包（制作/安装/信任）；`U10` 通用领域场景扩展；`U11` 第三方 / MCP 式外部工具接入；`U12` 下游向上游主动沟通是否放开。
- `U9` Agent 配置提交**已部分收敛**（2026-09-15 D20-⑧）：提示词 / loop / 模型三项定案；**剩余**=工具与工具包挂载编辑、配置回滚交互。
- 2026-09-15 新增：`U13` 模型用量与费用统计；`U14` 密钥加密与系统钥匙串；`U15` 配置版本回滚；`U16` 网络代理与自签证书。
- 历史 `U2~U7` 已定案或随会议功能移除；编号不复用。

### 3.4 阶段编号（`S0`~`S52`，`plan/development.md` §6）

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
| `S10` | 移除 mock 与 Agent 默认不配置模型（需求变更，prd D21） | [plan](plan/2026-09-16-s10-remove-mock.md) · [changes](changes/2026-09-16-s10-remove-mock.md) |
| `S11` | 模板库删除/停用与一键配置模型（需求变更，prd D22） | [plan](plan/2026-09-16-s11-template-delete-bulk-model.md) · [changes](changes/2026-09-16-s11-template-delete-bulk-model.md) |
| `S12` | 工具模块瘦身（工具包详情弹窗、去掉 loop 策略列表） | [plan](plan/2026-09-16-s12-tools-module-simplify.md) · [changes](changes/2026-09-16-s12-tools-module-simplify.md) |
| `S13` | `ask_user` 独立为 `interaction`（交互）工具包（prd D23） | [plan](plan/2026-09-16-s13-ask-user-interaction-package.md) · [changes](changes/2026-09-16-s13-ask-user-interaction-package.md) |
| `S14` | 删除「默认路由」功能（prd D24；生效链收敛为两级） | [plan](plan/2026-09-16-s14-remove-model-routing.md) · [changes](changes/2026-09-16-s14-remove-model-routing.md) |
| `S15` | 项目详情页瘦身：去「项目信息」卡、导出入口上移、运行细条归位编排图顶部（prd D25） | [plan](plan/2026-09-16-s15-project-detail-slim.md) · [changes](changes/2026-09-16-s15-project-detail-slim.md) |
| `S16` | 会话页瘦身：去掉「实时通道已连接」成功态提示，仅断开时警告 | [plan](plan/2026-09-16-s16-session-page-slim.md) · [changes](changes/2026-09-16-s16-session-page-slim.md) |
| `S17` | 编排图交互修复 + 「浏览 / 编辑」双模式（prd D26） | [plan](plan/2026-09-16-s17-orchestration-edit-mode.md) · [changes](changes/2026-09-16-s17-orchestration-edit-mode.md) |
| `S18` | 删除边可用性修复（14px 点击热区 + 「删除选中边」按钮） | [plan](plan/2026-09-16-s18-edge-delete-affordance.md) · [changes](changes/2026-09-16-s18-edge-delete-affordance.md) |
| `S19` | 会话页 Agent 列表只保留名称与状态（去掉消息预览与排队数） | [plan](plan/2026-09-16-s19-session-list-name-status.md) · [changes](changes/2026-09-16-s19-session-list-name-status.md) |
| `S20` | 会话页聊天区放大（消息区高度自适应视口 + 左右两栏可收起） | [plan](plan/2026-09-16-s20-session-chat-roomier.md) · [changes](changes/2026-09-16-s20-session-chat-roomier.md) |
| `S21` | 未完成回合改由 Agent 自查与询问（删平台检测与固定三选；新增 `session_recent`，prd D27） | [plan](plan/2026-09-16-s21-agent-driven-recovery.md) · [changes](changes/2026-09-16-s21-agent-driven-recovery.md) |
| `S22` | 会话流去掉事件筛选与「工作日志」折叠包装（prd D28；FR-30 修订） | [plan](plan/2026-09-16-s22-session-stream-inline.md) · [changes](changes/2026-09-16-s22-session-stream-inline.md) |
| `S23` | 对话消息按 Markdown 渲染（自研零依赖解析器，prd D29） | [plan](plan/2026-09-16-s23-message-markdown.md) · [changes](changes/2026-09-16-s23-message-markdown.md) |
| `S24` | 工具调用/结果不显示的缺陷修复（事件字段契约对齐，`lib/event-display.ts`） | [plan](plan/2026-09-16-s24-tool-event-fields.md) · [changes](changes/2026-09-16-s24-tool-event-fields.md) |
| `S25` | 基础工具包「全员必装」强制化（读/写两侧归一，prd D30） | [plan](plan/2026-09-16-s25-packages-always-mounted.md) · [changes](changes/2026-09-16-s25-packages-always-mounted.md) |
| `S26` | 工具结果条目只显示工具名（`eventRow` 行渲染规则，prd D31） | [plan](plan/2026-09-16-s26-tool-result-name-only.md) · [changes](changes/2026-09-16-s26-tool-result-name-only.md) |
| `S27` | 改用成熟框架渲染 Markdown（`react-markdown`+`remark-gfm`，支持 GFM 表格，prd D32） | [plan](plan/2026-09-16-s27-markdown-framework.md) · [changes](changes/2026-09-16-s27-markdown-framework.md) |
| `S28` | 工具调用参数默认折叠（`bodyMode: collapsed`，prd D33） | [plan](plan/2026-09-16-s28-tool-call-args-collapsed.md) · [changes](changes/2026-09-16-s28-tool-call-args-collapsed.md) |
| `S29` | 「提示词预览」点击无反应的缺陷修复（预览弹窗挂到详情/列表两个分支） | [plan](plan/2026-09-16-s29-preview-modal-branch.md) · [changes](changes/2026-09-16-s29-preview-modal-branch.md) |
| `S30` | 工具调用文本化（DSML）根因修复 + 兼容层（追问轮带 tools，prd D34） | [plan](plan/2026-09-16-s30-dsml-tool-calls.md) · [changes](changes/2026-09-16-s30-dsml-tool-calls.md) |
| `S31` | 发送消息后输入框残留文字（乐观清空） | [plan](plan/2026-09-16-s31-input-clear.md) · [changes](changes/2026-09-16-s31-input-clear.md) |
| `S32` | 询问答复入口归位（会话窗口输入框上方答复，右栏/任务页只提示，prd D35） | [plan](plan/2026-09-16-s32-question-in-session.md) · [changes](changes/2026-09-16-s32-question-in-session.md) |
| `S33` | 询问改为逐题作答 + 卡片左右滑动（攒齐一次提交，prd D36） | [plan](plan/2026-09-16-s33-question-carousel.md) · [changes](changes/2026-09-16-s33-question-carousel.md) |
| `S34` | 会话窗口铺满屏幕 + 自动跟随最新消息；工具报错显示报错内容（prd D37） | [plan](plan/2026-09-16-s34-scroll-and-tool-errors.md) · [changes](changes/2026-09-16-s34-scroll-and-tool-errors.md) |
| `S35` | 会话窗口新增「详细日志（trace）」视图（原始事件全量 + 可展开 payload，prd D38） | [plan](plan/2026-09-16-s35-trace-view.md) · [changes](changes/2026-09-16-s35-trace-view.md) |
| `S36` | 任务汇报闭环：汇报通知「事实 + 据此继续」+ 委派人上下文新增「我委派出去的任务」（prd D39） | [plan](plan/2026-09-16-s36-task-report-loop.md) · [changes](changes/2026-09-16-s36-task-report-loop.md) |
| `S37` | 暂停/停止的回合中断语义修复（用户报告"暂停无效"；prd D40） | [plan](plan/2026-09-16-s37-pause-interrupt.md) · [changes](changes/2026-09-16-s37-pause-interrupt.md) |
| `S38` | 询问等待的状态语义「等待回复中」（用户口径；prd D41） | [plan](plan/2026-09-16-s38-waiting-for-question.md) · [changes](changes/2026-09-16-s38-waiting-for-question.md) |
| `S39` | 时间显示改用本地时间（用户报告"trace 时间不对"；prd D42） | [plan](plan/2026-09-16-s39-local-time.md) · [changes](changes/2026-09-16-s39-local-time.md) |
| `S40` | 开启 think 并在会话里显示思考（用户口径；prd D43） | [plan](plan/2026-09-16-s40-think.md) · [changes](changes/2026-09-16-s40-think.md) |
| `S41` | 思考条目默认折叠（用户口径；prd D44） | [plan](plan/2026-09-16-s41-thought-collapsed.md) · [changes](changes/2026-09-16-s41-thought-collapsed.md) |
| `S42` | 输入框上方的「现在在干什么」等待提示（用户口径；prd D45） | [plan](plan/2026-09-16-s42-composer-status.md) · [changes](changes/2026-09-16-s42-composer-status.md) |
| `S43` | 思考行标出来源步骤（用户提问"为什么会有两个连续的思考"；prd D46） | [plan](plan/2026-09-16-s43-thought-purpose.md) · [changes](changes/2026-09-16-s43-thought-purpose.md) |
| `S44` | 会话流显示计划（`plan`）行（用户口径"这个也需要显示出来"；prd D47） | [plan](plan/2026-09-16-s44-plan-visible.md) · [changes](changes/2026-09-16-s44-plan-visible.md) |
| `S45` | 审批卡按会话归属显示（用户口径"谁的审批显示在谁的窗口"；prd D48） | [plan](plan/2026-09-16-s45-approval-scope.md) · [changes](changes/2026-09-16-s45-approval-scope.md) |
| `S46` | 会话相互独立：「发送中」按会话记（用户报告"一个角色发消息后其他角色发不了"；prd D49） | [plan](plan/2026-09-16-s46-sending-per-session.md) · [changes](changes/2026-09-16-s46-sending-per-session.md) |
| `S47` | 修「系统挂了」：嵌套唤醒死锁 + 重启后不恢复（用户报告；prd D50） | [plan](plan/2026-09-19-s47-wake-deadlock-recovery.md) · [changes](changes/2026-09-19-s47-wake-deadlock-recovery.md) |
| `S48` | 修「应用挂了」：实时帧不再每帧触发整页重渲染（用户报告；prd D51） | [plan](plan/2026-09-19-s48-realtime-render-storm.md) · [changes](changes/2026-09-19-s48-realtime-render-storm.md) |
| `S49` | 去掉「停止生成」；暂停在轮次边界停止循环（用户口径；prd D52） | [plan](plan/2026-09-19-s49-pause-at-loop-boundary.md) · [changes](changes/2026-09-19-s49-pause-at-loop-boundary.md) |
| `S50` | 按职能派单 / 待领取任务每回合可见 / 文档进 `docs/`（用户口径三条；prd D53） | [plan](plan/2026-09-19-s50-roster-pending-docs.md) · [changes](changes/2026-09-19-s50-roster-pending-docs.md) |
| `S51` | 会话顶部显示「正在执行的任务」（用户口径；prd D54） | [plan](plan/2026-09-19-s51-session-current-task.md) · [changes](changes/2026-09-19-s51-session-current-task.md) |
| `S57` | 「任务与产出物」用户只读：不派单、不改状态（用户口径；prd D61） | [plan](plan/2026-09-21-s57-task-panel-readonly.md) · [changes](changes/2026-09-21-s57-task-panel-readonly.md) |
| `S56` | 删除产出物「版本历史」功能（用户口径"产出物的历史版本功能删除"；prd D60） | [plan](plan/2026-09-20-s56-remove-artifact-history.md) · [changes](changes/2026-09-20-s56-remove-artifact-history.md) |
| `S55` | 「任务与产出物」里任务状态可改（用户报告"任务状态是不能修改的"；prd D59）——**界面入口已由 S57 移除** | [plan](plan/2026-09-20-s55-task-state-editable.md) · [changes](changes/2026-09-20-s55-task-state-editable.md) |
| `S54` | 产出物「版本历史」+「退回此版本」（用户报告"产出物没有退回版本功能"；prd D58）——**已由 S56 删除** | [plan](plan/2026-09-20-s54-artifact-version-rollback.md) · [changes](changes/2026-09-20-s54-artifact-version-rollback.md) |
| `S53` | 产出物登记免审批 / 角色主动续领任务 / 取消「受阻」（用户口径三条；prd D56/D57） | [plan](plan/2026-09-20-s53-submit-free-proactive-tasks.md) · [changes](changes/2026-09-20-s53-submit-free-proactive-tasks.md) |
| `S52` | 模型请求超时改为「空闲超时」（用户报告；prd D55） | [plan](plan/2026-09-19-s52-model-idle-timeout.md) · [changes](changes/2026-09-19-s52-model-idle-timeout.md) |

- **测试规则编号**（`testing/plan.md` §2，共 33 条）与**规则→用例映射**（§5）配套使用；验收脚本 1~8 见 `prd` §9，可执行套件在 `tests/acceptance/prd-section9.test.ts`。
- 覆盖率门禁：`npm run coverage`（文件级触达；口径见 `testing/plan.md` §4）。

## 4. 维护约定

1. 新增文档必须在本文件 §1 登记，并放入对应类别目录。
2. 每次改动先写 `docs/plan/` 方案、后写 `docs/changes/` 记录（标准见项目开发规范）。
3. 术语以本文件 §2 为准；同一概念不得在其它文档换词（例：不写"工作空间"表示私有区、不写"会议""拍板"表示已删除机制）。
4. 跨文档引用一律用相对路径 Markdown 链接；改文件名时同步修正引用。
