# 开发方案 · 文档收口（需求口径收敛 + 缺陷修复）

> 类别：plan · 状态：待评审 · 类型：文档收口（非实现）· 日期：2026-09-14
> 需求来源：用户与 PM/架构师逐题确认的 28 条口径（本方案 §2 全量登记）
> 关联：[prd.md](../requirements/prd.md)、[architecture.md](../design/architecture.md)、[abstraction.md](../design/abstraction.md)、[agent-runtime.md](../design/agent-runtime.md)、[data-storage.md](../design/data-storage.md)、[orchestration.md](../design/orchestration.md)、[tools.md](../design/tools.md)、[tool-packages.md](../design/tool-packages.md)、[ui.md](../design/ui.md)、[workspaces-artifacts.md](../design/workspaces-artifacts.md)、[contract.md](../api/contract.md)、[plan.md](../testing/plan.md)
> 前置评审：本轮评审发现 **24 项文档内部/技术缺陷**（§4 全量登记，含 6 项 P0）。**本方案不实现代码**，只收敛文档与配置模板。

---

## 1. 背景

2026-09-14 的仓库处于「设计文档体系保留、实现已清空」状态（HEAD `0217e21`）。同日经历了 `remove-meeting`、`shared-workdir`、`revision-home-orchestration`、`abstraction-design` 四次改动，**新需求与旧文档未完全回写**，导致：

1. 需求与设计出现实质冲突（doc 审批、回退入口、实例配置可改性）；
2. 多轮"自检结论"失真（声称 0 断链 / 0 命中，实际存在失效引用与幽灵配置键）；
3. 用户随后做出的 28 条新口径**尚未落进任何文档**。

本方案把 28 条口径一次性落进 17 个文件，并顺带修掉评审发现的 24 项缺陷，使文档重新成为可编码基线。

**明确不做**：不创建 `src/`、`web/`、`tests/`、`package.json`；不重建里程碑表（另行开篇）；不设计里程碑概念（用户已明确延后）。

---

## 2. 口径总表（28 条 · 已确认）

### 2.1 产物、文件与审批（1–9）

| # | 议题 | 最终口径 | 覆盖的旧口径 |
| --- | --- | --- | --- |
| 1 | `artifact_submit` / `artifact_rollback` | **删除两个工具** | D3、D13①、D14-⑧ 的"显式登记" |
| 2 | 产物记录 | 改为**系统自动聚合**（任务收尾 / 回合结束兜底），一条，不堆版本；`taskId` 可为 null | D3「提交制」 |
| 3 | 版本快照与回退 | **全删**（`artifact-versions/`、`versionDir`、回退服务与端点、FR-16） | D3「可回退」、H2 |
| 4 | 两扇审批门 | **删除** `artifactPolicy`、`APPROVAL__DOC_SUBMIT_APPROVAL`、`APPROVAL__CODE_SUBMIT_APPROVAL`；审批只剩**高危命令** | D13②、D16-⑥、D17-④ 托盘/信任开关 |
| 5 | 基础工具包 | **7 → 6**：`fs`/`cmd`/`memory`/`session`/`approval`/`task`；`workdir_edit` 归入 `fs` | D19-②、FR-26 |
| 6 | 文件权限与并发 | 权限判定**只认 `file-owners`**；互斥用 `KeyedLock`；**检查→写入→更新归属在同一临界区**；无主文件首个获锁者认领 | "文件编辑会话锁"（已废） |
| 7 | `cmd_run` 与归属 | 执行**前后对 workdir 做归属审计**（变更清单入任务日志）；owner 可追认或拒绝 | 「已知边界：不按 owner 校验」 |
| 8 | 错误码分工 | 非 owner 写 → `ERR_FORBIDDEN`；内容并发冲突（`expectedHash` 不符）→ `ERR_CONFLICT` | sandbox「编辑锁 → ERR_CONFLICT」 |
| 9 | 实例配置 | **MVP 只读**：系统模板与项目实例都不可改（改配置归 U9）；实例仅可**从团队移除**（不物理删数据） | FR-02「实例可改名/换模型/换 loop」、US-11 |

### 2.2 状态、控制与调度（10–18）

| # | 议题 | 最终口径 | 覆盖的旧口径 |
| --- | --- | --- | --- |
| 10 | Agent 状态 | **三态**：`空闲` / `工作中` / `摸鱼中`。**`等待中` 不是独立状态**，而是"工作中"的子阶段（等你答复/审批时徽标显示「工作中（等待你）」） | D16-② 三态 idle/working/waiting |
| 11 | 摸鱼中（新增） | **派生状态**：无活动回合 **且** 存在未收尾的任务卡（或队列积压且被停机）。判据 = 缺 `turn_end` + 卡未终态；可重建 | — |
| 12 | 删除的控制 | 删 `paused`/`resume`、删 Agent 级 `stop` 端点、删 `enabled` 开关、删会话 `archived` 归档态 | D19-⑥、D14-⑨、D16-② |
| 13 | 停止生成 | 保留（会话流内）：停当前回复输出、队列保留 | D17-⑥、ui.md §4；**FR-18 的 P1 定位需修** |
| 14 | 停止工作（新增） | **会话头 + 画布节点菜单 + 顶部**三处按钮：停当前回合（杀命令、不回滚）→ 该 Agent 进摸鱼中；队列保留；**卡保持 `executing`** | — |
| 15 | 全部停止（新增） | 顶部一键：所有工作中的 Agent 进摸鱼中；**同时作废**待答提问（`voided`）与待批审批（`expired`），**保留记录**并在右栏标注"已作废（因全部停止）" | — |
| 16 | 开工 / 继续（新增） | 顶部**全局「开工」**（对应全部停止）+ 每个摸鱼中会话头的**「继续」**（从断点恢复该卡）。**发消息等效于开工** | — |
| 17 | 自动调度 | **无活动回合 + 队列非空 + 非摸鱼中 → 自动开工**；首次进入由「开工」触发 | D18-③「唤醒消息」（措辞废弃） |
| 18 | 系统消息 | 与用户消息**同队列、同权**；"唤醒"一词废弃，改为"入队的系统消息" | D18-③ |

### 2.3 任务流转（19–27）

| # | 议题 | 最终口径 | 覆盖的旧口径 |
| --- | --- | --- | --- |
| 19 | 任务卡定位 | **卡只用于 Agent 之间的协作**（委派 + 验收）；**用户与 Agent 的对话不建卡**（产物记录 `taskId = null`） | D15 甲/乙模式、FR-08 |
| 20 | 状态机（单字段） | `published → executing → handed_in → verifying → done`；`verifying` 退回 → `returned`；终态 `done` / `cancelled` | D17-①、D19-⑤ |
| 21 | 执行槽 | **只有 `executing` 占用执行槽**（每 Agent 至多 1 个）；`handed_in`/`returned` 不占槽 → 派发者可继续做自己的活 | D17-①「至多 1 个 in_progress」 |
| 22 | 验收 | **派发者 A** 验收：**每轮开始前扫收件箱**（我是派发者且状态 ∈ {handed_in, verifying}）；验收**占回合、不占任务槽**；通过即 `done`（用户只观测） | D17-①、FR-08「用户确认 done」 |
| 23 | 退回 | 每张卡 **≤ 2 轮**；退回卡回受派者待办、不占槽、自行 `task_claim` 重做 | — |
| 24 | 退回超限 | 第 3 次不过 → **先 `ask_user` 问用户**（判定任务定义不清）→ 该卡置 `cancelled`（`reason = discarded_task_def`）→ 按新口径重开新卡 | — |
| 25 | 取消权限 | **只有派发者 A 能取消**自己派出的卡，且必须**从叶到根逐层取消**（有活跃下游时**不能取消**）；**右栏不设取消按钮**，所有取消由 Agent 执行（用户经对话表达意图） | — |
| 26 | `cancelled` 原因 | 仅两种：`user_cancelled`（用户表达后由 A 执行）、`discarded_task_def`（退回 2 轮不过） | — |
| 27 | 任务日志（新增） | `tasks/<taskId>.log.jsonl`：`{ts, seq, taskId, actor, type, from, to, summary, artifacts[], refs[]}`；**存结论与指针，不复制正文**；`summary` 在 `handed_in` / 验收 / 退回 / 关闭时**必填** | — |

### 2.4 收敛与确认（28 + 3 配套）

| # | 议题 | 最终口径 |
| --- | --- | --- |
| 28 | 意图路由 | **混合判定**：规则优先（明确的结束/取消信号直接执行），其余交模型判定「消息是否与当前任务相关」/「是否是一件事」；**结果可见、可一键撤销** |
| 28a | 无关消息 | 与当前**卡**无关时，不自动结束卡（卡只归 Agent 操作）；仅对**无卡工作**收尾，不产生终态变更（**取消 `auto_closed_unrelated` 这个原因**） |
| 28b | 半成品 | 停止后不回滚；**下个回合开始时强制告知 Agent「上次没干完」**（读自身最近产物记录与未完成标记） |
| 28c | 自动链 | **不加限制**（用户明示）。风险见 §5 |

---

## 3. 逐文件改动清单

> 记法：`原` = 现行原文（引自当前工作区版本），`新` = 目标原文。仅列实质改动处，未列出的小节不动。

### 3.1 `docs/requirements/prd.md`

| 位置 | 原 | 新 |
| --- | --- | --- |
| §1 标题 | `需求文档（PRD）· Agent Haness v0.2` | `v0.3`（与 D19「需求修改 v0.3」一致） |
| §3 角色表 PM 行 | 「…**可按编排图向下游委派任务**（见 D15/D19）」 | 增补：「委派产生的任务卡的**验收与关闭由派发者负责**；用户与 Agent 的对话不产生任务卡（口径 19）」 |
| US-11 | 「项目进行中也可增删成员（MVP 删除=停用保留数据，可重新启用，见 D14-9）」 | 「项目进行中可增删成员；**移除 = 从团队/画布移除，会话与记忆保留但不再可交互**（不物理删除）；MVP 实例配置只读（口径 9）」 |
| US-12 | 「我能在界面查看提交记录（署名/版本/摘要）并回退」 | 「我能在界面看到每个 Agent 产出了哪些文件（署名/时间/所属任务）；**无回退**（口径 3）」 |
| US-17 / FR-28 | 画布描述 | 增补「**项目创建时编排图为空**，画布给出空态引导（口径：空图起步）」 |
| FR-02 | 「项目内实例可改名/改提示词/换模型/换 loop」 | **删除实例可改表述** → 「实例配置 MVP 只读（口径 9）」 |
| FR-06 | 共享工作目录与文件归属 | 增补「写入的权限判定与认领在**同一 KeyedLock 临界区**内完成；`cmd_run` 前后做归属审计（口径 6/7）」 |
| FR-07 | 「产出物提交制…可回退」 | 改为「**产物记录**：系统在任务收尾/回合结束时自动登记（署名/文件清单/摘要）；**无提交动作、无回退**（口径 1/2/3）」 |
| FR-08 | 任务轻量管理（含"用户仍可手动派单、改状态、终止与干预，**不受边约束**"） | 改为「**右栏任务列表只读**；用户经会话表达意图，由对应 Agent 执行；**取消只能由派发者从叶到根执行**（口径 25）」 |
| FR-12 / FR-29 | 右栏三列表 | 保持三列表（任务/询问/审批），**去掉任何产出物栏**；补「顶部：**开工 / 全部停止**」 |
| FR-13 | 工具执行与安全 | 增补 `cmd_run` 归属审计（口径 7） |
| FR-26 | 「7 个基础包」 | **6 个基础包**；`artifact` 包删除、`workdir_edit` 入 `fs`（口径 5） |
| FR-32 | 询问与答复（Agent waiting） | 改为「Agent 仍为**工作中**（等待你），非独立状态；**全部停止会作废待答提问**（口径 10/15）」 |
| FR-33 | 「暂停与停止…均需确认并留审计」 | **整条改写为**「**停止工作**：会话头/画布节点/顶部按钮，停当前回合、队列保留、卡保持 `executing`；**全部停止**：一键停止所有工作中的 Agent 并作废待答/待批（口径 13/14/15）」；删除暂停/恢复 |
| D3 | 提交制 | 改「共享工作目录直接产出 + **自动产物记录**，无提交、无回退（口径 1–3）」 |
| D13② | doc 审批默认 | 改「**审批只剩高危命令**；文档/代码产物一律免审批（口径 4）」 |
| D14-⑧ | 代码任务级聚合 | 扩为**所有产出类型**统一自动聚合（口径 2） |
| D14-⑨ | 实例删除=停用保留数据 | 改「**移除实例**=移出团队，数据保留但不可交互（口径 9）」 |
| D15 | PM 定位与任务通道 | 修订说明补「**卡仅用于 Agent 间**；用户对话不建卡（口径 19）」 |
| D16-② | 「Agent 级状态 MVP 收敛为 idle/working/waiting 三态」 | 改「**空闲/工作中/摸鱼中**；等待中不是独立状态（口径 10/11）」 |
| D16-⑤ | 模板快照 | 保留；补「实例配置 MVP 只读（口径 9）」 |
| D16-⑥ | doc 审批预览 | **删除**（口径 4） |
| D17-① | 任务激活不抢占 / 终止语义 | 改「每 Agent 至多 1 个 `executing`；`handed_in`/`returned` 不占槽（口径 21）」 |
| D17-④ | doc 审批托盘 / 信任开关 | **删除**（口径 4） |
| D17-⑤ | 未完成回合横幅三选 | 改「**摸鱼中** + 重开时告知「上次没干完」（口径 28b）」 |
| D17-⑥ | 全局进行中细条 | 保留「n 个 Agent 正在工作」；补**开工/全部停止**；同时修 FR-18 的 P1 冲突 |
| D19-⑤ | 各 Agent 独立工作 | 增补「**无活动 + 队列非空即自动开工**；全部停止后需「开工」才恢复（口径 17/16）」 |
| D19-⑥ | 只有暂停/停止 | **改写**为「只有**停止工作 / 全部停止 / 开工**」（口径 12–16） |
| D19-⑦ | 询问机制 | 保留；补「全部停止会作废待答提问（口径 15）」 |
| §6 NFR 可恢复性 | — | 增补「重启后处于摸鱼中/待启动，**不自动开工**，需「开工」或发消息（口径 16/17）」 |
| §8 边界 | — | 删除"不做回退"相关悬空；补「**不加自动链限制**（已接受风险，见 §5）」 |
| §9 验收 4 | 「他人产出物不可修改（ERR_FORBIDDEN）」 | 增补「含 `cmd_run` 通道（执行前后审计，口径 7）」 |
| §9 验收 5 | 「编码阶段按 `docs/plan/development.md` 执行」 | **删除该句**，改为「按 `docs/plan/` 的里程碑方案执行（**待重建**，见 §6 未决）」 |
| §9 验收 7 | 「暂停后不领取新任务、停止后任务终止」 | 改为「**停止工作 → 该 Agent 进摸鱼中；开工/发消息 → 从断点继续；任务 done/cancelled → 回空闲**」 |
| 新增 FR-34 | — | 「**任务卡与任务日志**：卡仅用于 Agent 间委派与验收；完整记录状态变更/总结概要/产物/事件定位（口径 19/20/27）」 |
| 新增 FR-35 | — | 「**意图路由**：判定消息与当前任务的相关性并可见可撤销（口径 28）」 |
| 新增 FR-36 | — | 「**全局运行控制**：开工 / 全部停止（含作废待答与待批）（口径 15/16）」 |

> 编号策略：新增用 FR-34~36（**不复用空缺的 FR-09/FR-20**），并在 §5 末尾补一行说明。

### 3.2 `docs/design/agent-runtime.md`

| 位置 | 改动 |
| --- | --- |
| §1 | 实例可改配置的表述 → 只读；补「移除实例」语义（口径 9） |
| §2 状态机 | **重画**：`空闲 ⇄ 工作中（含"等待你"子阶段）`、`工作中/空闲 → 摸鱼中`、`摸鱼中 → 工作中`（开工/发消息）；删 `paused`/`enabled`/`archived` 相关段（口径 10–12） |
| §2 三个注 | 「停用 / 暂停 / 停止的区别」整段**重写**为「停止工作 / 全部停止 / 开工 / 摸鱼中」四者定义（口径 11–16） |
| §3（**删除 47–64 行整块**） | 「⚠️ 实现现状（2026-09-14 重构 P6…）」以**已删除的代码**充当现状，与「实现已清空」矛盾 → **删除** |
| §3 loop 表 | 保留目标形态；删「现状」列（无代码可对照） |
| §4 上下文组装 | 删「产出物索引（artifact 摘要）」中的版本语义；补「**产物记录（含 taskId）**」；补「回合开始时注入『上次未干完』提示（口径 28b）」 |
| §4 任务上下文 | 重写为「当前卡（`executing`）+ 收件箱（`handed_in`/`verifying`）两份上下文」；删 `blocked`；补「验收回合」 |
| §5 模型路由 | 保留；补「**验收回合用派发者自己的模型**（实现细节，本方案默认）」 |
| §6 工具表 | 删 `artifact_submit`/`artifact_rollback` 行；`workdir_edit` 行补「归入 `fs` 包」；`ask_user` 行补「**归入 `approval` 包**」；`task_*` 收敛为 `task_assign`/`task_claim`/`task_cancel`/`task_review`（待定名，见 §6 未决） |
| §6 审批默认 | 改为「**只有高危命令需审批**」（口径 4） |
| §6 任务工具段 | 重写为「卡 = Agent 间协作；用户对话不建卡；取消只有派发者能从叶到根执行」（口径 19/25） |
| §7 回合执行错误处理 | 「审批等待跨重启」保留；「询问等待跨重启」改写为摸鱼中语义 |
| §7 新增 | 「**自动调度规则**：无活动 + 队列非空 + 非摸鱼中；系统消息与用户消息同权」（口径 17/18） |
| §8 审计 | 补「任务日志与产物记录」（口径 27） |

### 3.3 `docs/design/data-storage.md`

| 位置 | 改动 |
| --- | --- |
| §2 顶层布局 | 删 `artifact-versions/`；`artifacts.jsonl` 改名/降级为**产物记录**；新增 `tasks/<taskId>.log.jsonl` |
| §3 `project.json` | 删 `artifactPolicy`；team 数组删 `enabled`、`loop`/`tools` 的"可覆盖"语义；补 `scenario` |
| §4.1 meta | 删 `archived`（会话状态只剩 active/suspended[派生]）；补「上次未干完」标记位；`summaryRefs` 与 `summary` 事件字段对齐（修 §4 缺陷） |
| §4.2 kind 表 | 删 `approval_request` 的 doc 预览语义；新增 `task_log` 投影说明；`message` 行补「停止时不落盘」 |
| §5 记忆文件 | 不动（除清理失效编号引用） |
| §6 产物 | **整节重写**：删版本/回退/`versionDir`/`state` 流转；改为 `{id, taskId, submitter, files[], diffSummary, ts}`；补「自动生成时机」 |
| §6.1 归属表 | 补「**删除/重命名**时归属行的处理：relPath 失效由启动自检标注；`edits` 保留历史」；补「无主文件并发首写：锁内认领」 |
| §7 任务 | **重写**：单字段状态机（口径 20）、执行槽规则（21）、验收与退回（22/23）、取消权限（25）、`cancelled.reason`（26）；新增任务日志 schema（27） |
| §7 审批 | 补 `expired` 的**触发者**（架构 §7 要求"删除项目时置 expired"）；补「全部停止 → 作废为 expired」（口径 15） |
| §7 询问 | 补 `voided` 状态（口径 15） |
| §8 角色模板 | 「实例创建时快照」保留；补「实例配置只读」 |
| §9 迁移 | 补「`schemaVersion` 迁移策略」（修 deploy 缺陷 D5） |

### 3.4 `docs/design/tools.md`

- §1：保留"工具是唯一通道"。
- §2：`ToolDefinition` 补 `allowedRoots`/`package`/`timeoutMs`（与 `abstraction.md` 对齐，修缺陷 A9）；`needsApproval` 的"doc 类审批"示例删除。
- §3 清单：删 `artifact_submit`/`artifact_rollback`；`task_*` 收敛（`task_view`/`task_list`/`task_update` 删除或降级，见 §6）；**`ask_user` 补 `package: "approval"`**（修缺陷 C8）；`workdir_edit` 补 `package: "fs"`。
- §4 角色矩阵：删"产出物登记""回退请求"两行；`workdir_edit` 行改为 `fs` 包授权；任务行脚注重写（口径 19/25）。
- §5 调用协议：删"命中审批 → 产出 approval_request"中的 doc 分支；补 `cmd_run` 归属审计步骤。
- §6 写通道：**三条 → 两条**（`workdir_edit` + `cmd_run`）；删通道②（`artifact_submit`）。
- §6 末：删「已知边界：cmd_run 不按 owner 校验」→ 改为「`cmd_run` 前后做归属审计」（口径 7）。

### 3.5 `docs/design/tool-packages.md`

- §2 包模型：`required` 说明不变；示例 `artifact` 包删除。
- §3 七个包 → **六个**：

| 包 id | 工具 |
| --- | --- |
| `fs` | `fs_read_file`、`fs_list_dir`、`fs_search`、**`workdir_edit`** |
| `cmd` | `cmd_run` |
| `memory` | `memory_search`、`memory_append` |
| `session` | `session_search` |
| `approval` | `approval_query`、**`ask_user`** |
| `task` | `task_assign`、`task_claim`（+ 取消/验收工具，见 §6） |

- §5 展示契约：不变（端点保持）。

### 3.6 `docs/design/orchestration.md`

- §1 铁律：第 4 条「用户不受边约束」→ 改为「**用户经会话表达意图，由对应 Agent 执行；右栏只读**」（口径 25）；第 5 条补「**自动调度**：无活动 + 队列非空即开工」（口径 17）。
- §2 数据模型：补「**项目创建时图为空**，无默认边」（口径：空图起步）；删 `enabled=false` 相关校验说明（口径 12）。
- §3 编辑校验：删「未停用实例」约束；补空态引导要求。
- §4 运行模型：**重写**为「发布 → 领取 → 执行 → 交回 → 验收 → 关闭」，含退回 ≤2 轮与超限 `ask_user`（口径 20–24）；「激活即唤醒」改为「入队的系统消息」（口径 18）。
- §5 暂停/停止：**整节重写**为「停止工作 / 全部停止 / 开工 / 继续」，删暂停与恢复端点（口径 12–16）。
- §6 观测：节点徽标改为「空闲 / 工作中（等待你）/ 摸鱼中」；补「待启动」派生显示。
- §7 接口与事件：删 `pause`/`resume`，`stop` 改为 `POST /api/projects/:pid/agents/:iid/stop-work`；新增 `POST /api/projects/:pid/halt-all`、`POST /api/projects/:pid/start`；错误码删暂停相关。
- §9 未决：保留 U12。

### 3.7 `docs/design/ui.md`

- §1 信息架构：补「顶部：**开工 / 全部停止**」。
- §3 拓扑页：节点菜单删"暂停"、改「**停止工作**」；补空图空态引导文案（口径：空图起步）。
- §4 对话页：删「暂停/停止」中的暂停；补「**停止工作**」「**继续**」；保留「停止生成」；删"未完成回合三选"改为「摸鱼中 + 重开时提示」。
- §5 右栏三列表：**保持三列表**；任务列操作列**改为只读**（删"终止""改状态"）；补「card 状态展示 + 任务日志入口」；删产出物栏相关残留。
- §6 交互约定：删「实例停用（enabled=false）」行；补「**全部停止**：作废待答提问/待批审批并标注『已作废（因全部停止）』」；补「停止工作 → 摸鱼中」；补「意图路由结果标签 + 撤销」。
- §7 与接口对应：同步 §3.6 的端点变化。
- §8 P1 清单：把「批量审批（doc 托盘）」删除（口径 4）；「多标签并行查看」移出 P1 或标明现状（修缺陷 4.12）。

### 3.8 `docs/design/workspaces-artifacts.md`

**建议整篇重写为「工作目录与产物记录设计」**，因为现有 §2/§2.3/§3/§4 的提交制与回退全部失效。要点：

1. 工作目录是唯一产出地；读共享、写按归属（保留）。
2. `workdir_edit` 是唯一写通道 + `cmd_run` 副作用受审计（口径 7）。
3. **产物记录自动生成**（时机/字段/diffSummary），无提交动作（口径 1/2）。
4. 删 §3 回退整节、§4 的 `approved/reverted` 状态机（口径 3）。
5. §6 审批默认值表：整表替换为「只有高危命令需审批」（口径 4）。
6. **修 `§2.2` 重号**（现第 37 行与第 52 行同为 `### 2.2`，导致跨文档引用错指；缺陷 1.3）。

### 3.9 `docs/design/sandbox.md`

- §3.2：删「写 workdir 的冲突由**文件编辑会话锁**（ERR_CONFLICT）」→ 改为「归属判定 + `KeyedLock` 临界区；非 owner `ERR_FORBIDDEN`，内容冲突 `ERR_CONFLICT`」（口径 6/8）。
- §4.2 并发：同步上述措辞。
- §5.1：删 doc 提交审批相关（若引用）。
- §8 失败表：保留；补归属相关码。
- §10 验收要点：补「`/api/fs/browse` 的安全用例」（修缺陷 T6）。

### 3.10 `docs/design/memory.md`

- §3.1：修交叉引用「见 memory.md §5 摘要引擎」→ `§3.1`（在 `agent-runtime.md:82`，但此处登记以防误改）。
- §3.1 触发：删 `memory.checkpoint`（**该工具不存在**，缺陷 A6）→ 改为「关键事件（产物记录、审批、任务收尾）」；阈值 `~40` 定稿为明确值。
- §3：补**摘要引擎失败处理**（模型来源、重试、幂等重放后 `summaryId` 更新、持续失败时的上下文退化处理；缺陷 A3）。
- §6 恢复表：删「浏览器半截文本续补」中的三选措辞？保留；补摸鱼中语义。
- §7：`session.message_appended` 等**三套事件词汇**统一到 `data-storage §4.2` 的 kind（缺陷 C3）。

### 3.11 `docs/design/sessions.md`

- §2 状态机：删 `archived`；`suspended` 保留为 occupancy 派生投影（口径 12）。
- §3：补「会话状态与摸鱼中的关系」。
- §5：删「UI 多标签」（与 ui.md P1 冲突，缺陷 4.12）或明确为 P1。
- §6 事件表：`session.*` 三个事件名**统一到单一事件规范**（缺陷 C3）。

### 3.12 `docs/design/architecture.md`

- §4 模块树：删 `application/artifact/` 的提交/回退职责，改为「产物记录」；`server/http-routes` 注释同步 §3.6 端点。
- §4.1 端口：`ToolExecutor` 职责删"注册"、补"归属校验"；`FileStore` 职责删"编辑会话锁"（缺陷 3.2）。
- §5.2 产出物提交流程：**重写**为自动产物记录。
- §5.2b：补验收与退回环节。
- §7 一致性表：「停用忙碌实例」行删除；「并发写文件」行改归属 + KeyedLock；补「全部停止/开工」行。
- §8 安全边界：补 `cmd_run` 审计。
- §10 端口清单：与 `contract.md` 对齐（修缺陷 C5/C16）。
- §11 页面表：删「产出物面板」行；补顶部开工/全部停止（修缺陷 C14）。

### 3.13 `docs/api/contract.md`

- 删：`POST .../artifacts/:aid/rollback`、`GET/PUT /api/settings/models`（写已删除的 config.yaml，缺陷 C1）、`POST .../sessions/:sid/hangup`（P1 重叠，缺陷 C15）、`pause`/`resume`。
- 改：`POST .../agents/:iid/stop` → `/stop-work`；`GET .../tasks` 返回单字段状态 + 新增 `GET .../tasks/:tid/log`；`GET .../questions` 补 `voided`；`GET .../approvals` 补 `expired` 触发说明。
- 增：`POST /api/projects/:pid/halt-all`、`POST /api/projects/:pid/start`、`GET/POST .../sessions/:sid/...`（继续/停止生成）。
- WS：删 `session.updated` 或补齐其对应 kind；`message.chunk` 与 `data-storage.md:130` 的冲突要显式说明（缺陷 C4）；新增 `task.updated` 的字段含新状态；补 `question.voided`、`agent.halted`。
- 错误码表：补 `ERR_FORBIDDEN`（归属）与 `ERR_CONFLICT`（内容冲突）的**分工说明**（口径 8）；删暂停相关；保留 16 码并确保与 `abstraction.md:484` 一致（已一致，勿破坏）。

### 3.14 `docs/testing/plan.md`

- **规则改为稳定 ID**（修缺陷 P0-2/T4）：形如 `R-SINGLE-TASK`、`R-PATH-BOUNDARY`…，并删除序号引用；同步修 `abstraction.md:92` 的「规则 1/8/24」。
- 删规则 16（doc 审批预览）、18（doc 托盘/信任）——功能已删（口径 4）。
- 改规则 26（暂停/停止）→ 「停止工作 / 全部停止 / 开工」。
- 改规则 12：`文件编辑锁 ERR_CONFLICT` → 「非 owner `ERR_FORBIDDEN`；内容并发 `ERR_CONFLICT`」（口径 8）。
- 增规则：任务流转全链（发布/领取/交回/验收/退回 2 轮/超限 ask_user/丢弃）、任务日志完整性、意图路由可见可撤销、归属审计（`cmd_run`）、`/api/fs/browse` 安全用例（缺陷 T6）、任务去重（T7）、删除项目前置校验（T8）、错误码三层映射（T10）、工具包/模板展示端点（T11）、导出 zip（T12）。
- §4 门禁：补「**里程碑表待重建**，本文件的『按开发方案演示/验收列』暂不可执行」（缺陷 T3）。

### 3.15 `docs/operations/deploy.md`

- 删 `TASK__ASSIGN_BY_AGENT` 行（**该键在 `.env` 与 `.env.example` 中都不存在**，缺陷 D2）。
- 补 `.env.example` 的入库说明修正（见 §3.17）。
- 补 `LOG_LEVEL`（缺陷 D8）。
- 补「schemaVersion 迁移」指向 `data-storage §9` 的**真实内容**（缺陷 D5，需先在 §3.3 落地）。
- §2 脚本清单：**标注"待 `package.json` 建立后生效"**（缺陷 D4/T1）。
- §3 默认模型：明确「Mock 为默认演示档」或「DeepSeek 为默认」，消除与 `prd.md:113` 的冲突（缺陷 D3/H6）。

### 3.16 `docs/README.md`

- §1 文档地图：**份数自述与实际对齐**。实测：改造前 `docs/` 有 25 个 `.md`（本次评审前为 26，含已删的 `meetings.md`），而 §1 只登记 17 份；改造后为 26 份（本方案加入），需把 `abstraction.md`、`agent-templates.md`、`orchestration.md`、`tool-packages.md`、`ui.md`、`plan/*`、`changes/*` 全部补登（缺陷 C18/L9）。
- §2 术语表：新增「摸鱼中 / 停止工作 / 全部停止 / 开工 / 任务卡 / 任务日志 / 意图路由 / 产物记录」；删除「暂停 / 停止（Agent 级）」。
- §3 编号索引：登记新增 FR-34~36；说明 `cancelled.reason`。
- §3.2：历史编号 M/B/H/A/R 的引用**要么删除、要么标注"出处已删、不可追溯"**（缺陷 L3/L4）。

### 3.17 `.env.example` / `.gitignore`

- `.gitignore:19` 的 `.env.*` **放行 `.env.example`**：改为 `.env*` + `!.env.example`（修缺陷 D1；当前 `git check-ignore` 命中，与 `deploy.md:62`「入库模板」矛盾）。
- `.env.example`：删 `APPROVAL__DOC_SUBMIT_APPROVAL`、`APPROVAL__CODE_SUBMIT_APPROVAL`（口径 4）；修顶部注释「见 `src/shared/config.ts`」（该文件不存在，缺陷 D7）。

---

## 4. 评审发现的技术缺陷（24 项 · 本方案一并修复）

| 编号 | 缺陷 | 证据 | 修复落点 |
| --- | --- | --- | --- |
| P0-1 | `ask_user` 未归入任何工具包 → 按 `tools.md:22` 启动自检必然失败 | `tools.md:57` vs `tool-packages.md:35-41` | §3.5 `approval` 包 |
| P0-2 | 测试规则序号被错引且"未被引用"的判断为假 | `abstraction.md:92` vs `testing/plan.md:26,42`；`plan/…remove-meeting.md:24` | §3.14 稳定 ID |
| P0-3 | "停止生成"无任何接口 | `ui.md:80`/`prd.md:134` vs `contract.md:92-96` | §3.13 |
| P0-4 | doc 审批五处口径相反 | `prd.md:130,133` ↔ `workspaces-artifacts.md:97,102` | §3.1/3.4/3.8/3.14 |
| P0-5 | 产出物/回退入口四处互斥 | `workspaces-artifacts.md:78` vs `tools.md:69` vs `architecture.md:116` | §3.1/3.6/3.12 |
| P0-6 | 无里程碑表 → 测试/部署门禁不可执行 | `testing/plan.md:55`、`deploy.md:17-20`、无 `package.json` | §6 未决 + §3.14/3.15 标注 |
| A1 | `artifacts.jsonl` schema 缺 `versionDir` | `data-storage.md:156-163` vs `:166` | 随口径 3 一并删除该字段 |
| A2 | `cmd_run` 绕过 owner 与验收 4 冲突 | `workspaces-artifacts.md:89` vs `prd.md:68,155` | §3.4/3.8/口径 7 |
| A3 | 摘要引擎失败处理完全缺失 + 引用错 | `agent-runtime.md:82` → `memory.md §5`（实为 §3.1） | §3.3/3.10 |
| A4 | 归属表在删除/重命名时无维护规则 | `data-storage.md:146-147` | §3.3 §6.1 |
| A5 | 沙箱"更强隔离后端"无端口落点 | `sandbox.md:20` vs `abstraction.md:130-137` | §3.12（补端口或删承诺） |
| A6 | 文档引用了不存在的工具 `memory.checkpoint` / `resume_context` | `memory.md:36,72` | §3.10 |
| A7 | `archived` 单向/可逆矛盾；`enabled=false` 能否派发矛盾 | `sessions.md:19` vs `abstraction.md:85`；`orchestration.md:43` vs `ui.md:101` | §3.11/3.6（`archived` 与 `enabled` 均已删） |
| A8 | `SearchProvider` 不在端口清单 | `data-storage.md:234` vs `abstraction.md:118` | §3.12 |
| A9 | `ToolDefinition` 三处 schema 不一致 | `architecture.md:132` 漏字段 | §3.4/3.12 |
| C1 | `/api/settings/models` 写已删除的 `config.yaml` | `contract.md:59` vs `deploy.md:28` | §3.13 |
| C3 | 事件"单一规范"实为三套词汇 | `sessions.md:50-52`、`memory.md:77` | §3.10/3.11 |
| C4 | WS 事件与 log kind 无法一一对应 | `contract.md:101-113` vs `data-storage.md:111-127` | §3.13 |
| C5 | `architecture §10` 与 contract 端点大面积不一致 | `architecture.md:182` | §3.12 |
| C12/C13 | `question.asked` payload 与落盘 schema 不一致 | `contract.md:111` vs `data-storage.md:195-199` | §3.13 |
| D1 | `.env.example` 被 `.gitignore` 忽略、未入库 | `git check-ignore` | §3.17 |
| D2 | 幽灵配置键 `TASK__ASSIGN_BY_AGENT` | `deploy.md:51` | §3.15 |
| L1/L2 | 失效引用 `docs/plan/development.md`、`docs/changes/2026-09-08-m3-runtime-tools.md` | `prd.md:156`、`agent-runtime.md:60` | §3.1/3.2 |
| L6 | 用已删除代码充当"实现现状" | `agent-runtime.md:47-64` | §3.2 删除该块 |

---

## 5. 已接受风险（显式记录，不在本次加机制）

1. **自动链不加限制**（口径 28c）：一条用户消息可能点燃整条编排链，在 8 Agent 图上一次触发跑出十余个回合（每个回合一次模型调用）。链路本身有限（受出边数与 `executing` 槽位约束），但**成本没有上限**，且**重启前无人干预时会持续跑**。
   - 既有缓解：顶部「全部停止」提供**中断**能力（口径 15）。
   - 若日后要真正的上限，最小改动是加**链深计数**（自动触发回合的深度超过 N 即停在摸鱼中）。
2. **`cmd_run` 副作用仍是"审计"而非"阻止"**：命令可写工作目录外（逻辑沙箱不阻止），归属审计只能事后发现。
3. **用户侧手工改动不受归属校验**：用户改了 Agent 的文件后 owner 保留、快照失真（口径 6 的受控例外）。
4. **恢复后无强制一致性**：停止不回滚，半成品留在工作目录，靠"下回合告知上次没干完"降低误判，不保证 Agent 一定重做。

---

## 6. 未决（本方案不处理，另行开篇）

| # | 事项 | 说明 |
| --- | --- | --- |
| U-M1 | **里程碑概念** | 用户明确"之后商议"。形态（阶段节点 / 交付+验收 / 时间线 / 基线）未定，涉及新数据模型、任务与产物的挂接、右栏展示 |
| U-M2 | **无卡自由问答是否留档** | 用户明确"后续设计，与里程碑概念相关" |
| U-D1 | **里程碑表（原 `docs/plan/development.md`）** | 里程碑与验收列待重建；重建后 `testing/plan.md §4` 的门禁才可执行（缺陷 P0-6） |
| U-D2 | **`task_*` 工具最终集合与命名** | 现推断保留 `task_assign`/`task_claim` + 取消（`task_cancel`）/验收（`task_review`）；`task_view`/`task_list`/`task_update` 疑似冗余，需定稿 |
| U-D3 | **任务卡并发操作** | 两个 Agent 对同一张卡同时操作（如 A 取消、B 同时交回）的冲突语义与错误码 |
| U-D4 | **`agent-templates.md` 的"MVP 只读"范围** | 与口径 9 对齐（模板层与实例层都只读），需逐句核 |
| U-D5 | 平台/项目命名（原 U1，Agent Haness 疑似 Haness/Harness 拼写） | 保留在 PRD §10 |

---

## 7. 实施顺序

1. **先提交现状**：把当前未跟踪的 9 份设计文档 `git add` 入库（现 `git ls-files` 仅 14 个文件，v0.3 体系全在工作区，一次误清理即全失）。
2. `.gitignore` 放行 `.env.example`；`.env.example` 删两扇审批门。
3. PRD 口径改写（§3.1）——**需求真源先行**。
4. 设计文档：agent-runtime → data-storage → tools → tool-packages → orchestration → ui → workspaces-artifacts（重写）→ sandbox → memory → sessions → architecture。
5. 接口契约（contract）与测试计划（testing，含规则改稳定 ID）。
6. `docs/README.md` 术语表/编号索引/文档地图同步。
7. 全库复核（§8）+ 写 `docs/changes/2026-09-14-docs-reconciliation.md`。

---

## 8. 验证方式

1. **口径对齐**：§2 的 28 条在文档中逐一可查；无残留旧口径（grep `提交制|回退|artifact_submit|artifact_rollback|paused|enabled=false|archived|blocked|唤醒|托管|7 个基础包|doc 提交审批`）。
2. **编号稳定**：新增 FR-34~36；空缺号（US-5/6、FR-09/20）不复用；测试规则为稳定 ID 且无序号引用。
3. **引用可解析**：所有 Markdown 链接 `Test-Path` 通过；**跨文档章节号/规则号/文件路径**逐条人工核对（评审证明链接检查不覆盖此类引用）。
4. **配置一致**：`.env.example` 的键集合 = `deploy.md` 列出的键集合 = 实际 `.env` 键名集合（三方一致）；无幽灵键。
5. **自检诚实性**：本方案与后续 `changes/` 记录中的"验证结果"不得使用排除法制造"0 命中"；每项须给可复现命令。
6. **diff 审计**：每处改动可追溯到 §2 某条口径或 §4 某项缺陷，无夹带。

---

## 9. 回滚

改动集中于 `docs/` 与两个配置文件。文档改动尚未提交前：`git checkout HEAD -- <path>`；新增文件（本方案与 `changes/` 记录）直接删除。`.gitignore`/`.env.example` 为已跟踪文件，可用同一命令回滚。
