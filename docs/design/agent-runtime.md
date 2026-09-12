# Agent 运行时设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D1/D4/D11/D12、prd FR-02/04/10/13/14
> 关联：[architecture.md](architecture.md)、[data-storage.md](data-storage.md)、[sessions.md](sessions.md)、[memory.md](memory.md)

## 1. 三层角色抽象（可扩展的关键）

```
角色模板 Role Template（系统库，可增删）       ← 抽象层
   └─ 项目实例 Role Instance / Agent / Worker   ← 组队层（用户勾选角色生成）
        └─ 运行时执行：loop 策略 + 模型路由 + 工具集   ← 执行层
```

| 层 | 内容 | 用户能做什么 |
| --- | --- | --- |
| 模板 | roleId/名称/分类/职责/系统提示词/默认模型/默认 loop/默认工具/默认审批规则 | 新建/编辑/停用模板（US-10） |
| 实例 | displayName/提示词覆盖/模型/loop/工具集/审批覆盖 | 创建项目时勾选、改名、逐个覆盖配置；项目中增删（US-11） |
| 执行 | 由 loop 引擎按模板与实例配置驱动 | 不直接操作，通过实例配置影响 |

**内置模板（P0 种子）**：`pm`(项目经理)、`product`(产品)、`architect`(架构)、`ux`(交互)、`ui`(UI)、`dev`(高级开发)、`qa`(测试)、`ops`(运维)。
MVP 每项目每模板**至多 1 个实例**（D14-3）：instanceId 唯一（如 `pm_1`/`dev_1`）；同角色多实例（两位开发 → dev_1、dev_2，各自独立工作区/记忆/会话）为后续版本迭代。实例可被用户**停用/启用**（`enabled=false` 保留全部数据，D14-9）：停用后 dispatcher 不再为其领活，其 user 会话历史只读，可随时重新启用继续同一会话。

## 2. Agent 单工状态机（dispatcher 维护）

状态定义（对齐用户需求：工作中/会议中/等待中 + 空闲）：

```
         ┌─────────────────────────────────────────────┐
   idle ─┤  进入个人会话回合(被用户/任务唤醒)  → working  │
     ▲   │  被拉入会议(散会/退会回 idle)      → meeting   │
     │   │  回合内等待用户输入/审批            → waiting   │
     └───┴─────────────────────────────────────────────┘
```
(MVP 为**四态**，D16-②：无 Agent 级 suspended；重启恢复期间以"缺 turn_end=未完成"标记过渡，不设独立状态。) 

不变式（单工，D11）：
- 任一 Agent 同一时刻**至多一个活动会话**（working/meeting/waiting 均占用）。
- 进入会议 = 该 Agent 的 user 会话**挂起**（会话显示 suspended——occupancy 派生，D18-④，见 sessions.md §2；Agent 状态为 meeting）。
- 用户消息在 Agent 忙时入队，Agent 到**可中断点**后处理；界面显示"正在…/会议中/排队中"。

状态持久化：**occupancy 为运行期占用唯一真相（D18-④）**——dispatcher 把 agentId→活动{type,sessionId} 落盘 runtime.state.json，启动时由 session meta/回合与会议状态重建基线，此后以其为准；user 会话 `suspended` 等会话 meta 标志为**派生投影**（可留缓存、不单独作为真相，显示/恢复统一按 occupancy 重算）；log 事件（kind=`state`）为审计真相。重启重建见 §7 与 memory.md §6。

> **两级状态映射**：Agent 状态（idle/working/meeting/waiting **四态**，D16-②）由 dispatcher 维护，表示"该 Agent 能否领活"；会话状态**按类型分列**（user: active/suspended/archived；meeting: queued/proposed/open/blocked_waiting_user/closed，D16-①）见 sessions.md。审批等待 = Agent `waiting`，其 user 会话**仍为 active**（用户随时可继续发消息入队），不引入会话级 wait_user 状态（D14 评审定稿）；user 会话 `suspended` 一律由 dispatcher occupancy 派生（D18-④），不单独持久化为真相。
> **停用实例**：enabled=false 仅是调度开关（不进入上述状态机流转），实例的会话/工作区/记忆全部保留（D14-9）；**忙碌实例停用边界（D16/B6）**：working/meeting 中的实例，停用请求进入"待停用"——dispatcher 不再领新活，当前回合/会议到可中断点或自然结束后生效；waiting（审批等待）中的实例需用户先处理/取消对应审批后再停用。

## 3. 内置 agent loop（执行模板，D4）

loop = 一次"Agent 处理一条新输入"的执行编排。实现为策略注册表（strategy name → runner），用户只做选择与参数配置（不写代码，MVP）。

| strategy | 语义 | 适用 |
| --- | --- | --- |
| `direct` | 单轮：组装上下文 → 一次模型调用 → 返回文本（可带受限工具：检索/记忆/读文件） | 闲聊、澄清、快速问答 |
| `reflective` | 生成 → 自查(critique) → 修订，可配 maxIter(=2)，每步可换模型 | 文案/方案起草、PRD 初稿 |
| `plan-execute` | 显式计划(步骤清单)→ 逐步执行(每步可用工具：读写文件/检索/提交/命令)→ 验证/收尾 | 开发、测试、架构任务（重活） |
| （扩展位） | strategy 注册表开放 | 场景化新增 |

loop 通用参数：`maxIterations`、`stepModelOverride`、`toolBudget`、`interruptibleAfterStep: true`（可中断点）。
每次执行都会：
1. dispatcher 从 waiting/idle 领活并置 working；
2. 组装上下文（见 §4）；
3. 按 strategy 逐步执行：每步产出事件（thought/tool_call/tool_result/message/artifact…）→ **先落 log 再推送**（至少一次语义：先盘后推，避免 UI 有而盘无）。回合以 `turn_start` 事件开启、`turn_end` 事件收尾（事件模型见 data-storage §4.2）；
4. **流式文本是临时态**（D14-⑦）：模型增量先推送 UI，完整消息在流结束时合并为一条 `message` 事件落盘并发 `message.commit`；中途崩溃/刷新则半截内容不入 log，UI 标记"（未完成）"并提供补全/重说；
5. **plan-execute 的计划与执行进度**：以 `plan` 事件落盘（data-storage §4.2），断点/重启恢复时读取最近 plan 事件 + 摘要尾部重建，保证长任务续跑有依据；
6. 回合结束触发记忆维护（memory.md §5 摘要引擎）；
7. 回到 idle，处理队列中下一条（若存在）。

> 长任务（D16-③/D17-①）：plan-execute 是**单回合多步长跑**——turn_start 开启后连续执行，到"向用户汇报/提交产出"的自然停顿点才写 turn_end；回合内暂停仅三类：命中审批（Agent waiting）、会议抢占（成员入会，到可中断点挂起）、**用户终止任务**（D17-①：显式优先级指令，到当前可中断点打断并回注，停止该任务后续步骤）。恢复均由 dispatcher 在**同一会话内**续跑（plan 事件为断点依据，见下）；**用户普通消息在回合期间只入队、不打断**（可中断点是审批/会议抢占/用户终止使用的优先级闸门，不对普通消息开放）；**跨重启不自动续跑**：缺 turn_end=回合未完成，打开项目/重连时 UI 给出"汇报中断点/续做/忽略"入口（D17-⑤），或由用户下一条消息触发（agent-runtime §7、memory.md §6）。**排队消息恢复（D18-③，与"未完成回合不自动续跑"区分）**：重启后若某 Agent **无活动占用**且其 user 会话存在已入队未处理消息（按 dispatcher per-agent 游标 `lastHandledSeq` 判定），自动补一轮处理或由 UI 强提示，不要求用户再发消息唤醒——这里恢复的是**排队消息处理**，不续跑缺 turn_end 的未完成回合。

## 4. 上下文组装（每回合）

上下文 = 分层拼接，控制 token：

```
[系统提示] 角色模板系统提示词 + 实例覆盖
[场景设定] 平台角色定位(你是 <name>，项目 <project>，用户是老板…)
[全局记忆] global.jsonl 激活条目（数量上限+按相关排序，见 memory.md）
[个人记忆] 该 Agent 长期条目(角色记忆)
[会话窗口] 当前 session 摘要(滚动) + 最近 N 条全量消息(可含 thought/工具摘要)
[任务上下文] 正在执行任务 t_… 的信息
[产出物索引] 相关 artifact 摘要（名称/版本/文件），内容按需读
[工具规范] 可用工具 schema（按角色模板白名单）
```

组装顺序固定，可配置 `contextLimits`。检索到的旧会话片段按需注入（tag 为引用片段）。

**contextLimits MVP 默认值**（config.yaml 集中配置，可全局/实例覆盖，M11 定稿）：

| 配置键 | 默认 | 含义 |
| --- | --- | --- |
| `context.session.rawWindow` | 60 条 | 会话窗口保留的最近原文事件数（更早用滚动摘要替代） |
| `context.session.maxCharsPerMsg` | 2000 | 原文消息注入上限（超长截断） |
| `context.global.maxEntries` | 12 | 全局记忆 active 条目注入上限（相关度排序） |
| `context.role.maxEntries` | 12 | 角色记忆条目注入上限 |
| `context.search.maxSnippets` | 3 | 检索片段注入上限（每条 ≤600 字） |
| `context.tool.resultMaxChars` | 12000 | 工具结果注入上限（截尾保留，见 tools.md） |

**任务上下文**（D15/乙模式）：受派 Agent 回合内由 dispatcher 注入其**当前激活任务**（标题/受派者/状态/关联会话），仅用于告知职责与**代码产物按任务聚合的归属锚点**（workspaces-artifacts §2.2）。**激活规则（D16-④ 修订为 D17-①）**：每 Agent 至多 1 个 `in_progress` 任务——已有 in_progress 时**新任务不可置为 in_progress**（UI 置位被拦并提示原因，新任务可先置 `todo` 排队；**无静默自动回退**）；槽位仅由「任务完成（用户确认 done）」或「用户显式**终止**」释放。**激活即唤醒（D18-③）**：任务置 `in_progress` 时 dispatcher 向受派者 user 会话注入一条唤醒消息「请开始执行任务 t_…」，作为确定性开工触发（不依赖用户另行发消息）。**终止语义（D17-①）**：终止入口带确认；存在未结算改动时**先结算为一条 code artifact 快照**（归属落袋、可回退）再置 `terminated`；若 Agent 正在执行该任务，终止到**当前可中断点**生效并回注 Agent「任务已被用户终止」、停止该任务后续计划步骤（未执行步骤作废，不回放）。仅 `in_progress` 任务被注入上下文并充当代码聚合锚点；`todo` 任务与会话内口头指派不入上下文（对应改动按回合兜底，workspaces-artifacts §2.2）；状态流转默认由用户经 UI 驱动，Agent 以会话汇报完成。

## 5. 模型路由（D4/D5）

- Provider 注册表：`openai-compatible`（DeepSeek 等）/ `ollama` / `mock`。
- 路由规则（config.yaml 全局默认 + 实例覆盖）：
  1. 实例 `model` 优先；
  2. 未配置则用模板 `defaultModel`；
  3. 再退回 config `models.default`；
  4. loop 步骤可 `stepModelOverride`（如反思用更强模型）。
- 口径（B8 定稿）：实例/模板的 `model` 字段值一律引用 **provider id**（`config.models.providers[].id`，如 `deepseek-chat`/`ollama-qwen`/`mock`），具体模型名由 provider 内部指定；避免"provider/模型名"二义。
- 流式：模型网关统一返回增量，chunk 落 log(合并为 message 事件)并推送；中断/超时重试策略见架构 §7。

## 6. 工具集与安全边界（概要）

> **完整规范见两份专项文档**：[tools.md](tools.md)（工具注册表/内置清单/角色矩阵/调用协议/写通道）与 [sandbox.md](sandbox.md)（文件路径边界/命令执行/风险分级/审批/联网/审计）。本节只保留概要。

工具按「作用域 + 风险」注册：每工具声明 `{ name, description, paramsSchema, scope, risk, network, needsApproval, idempotent, availableIn, output }`（命名统一为 `<域>_<动作>`，如 `cmd_run`/`artifact_submit`，完整清单见 tools.md §3）。

| 工具（概要） | 作用域 | 风险 | 说明 |
| --- | --- | --- | --- |
| fs_read_file / fs_list_dir / fs_search | workdir + ro:// 只读 | none | **不含私有区**；读本人私有区一律走 ws_read（D14-⑩） |
| ws_write | workspace（本人） | none | 仅本人私有区可写；user 会话 |
| ws_read | workspace（本人） | none | 仅本人私有区可读；user+meeting（会议内可引用本人笔记/草稿，D14-⑩） |
| memory_append / memory_search | 记忆 | none | 个人记忆写、项目全局只读(默认；全局写仅 pm 例外) |
| session_search | 本项目会话 | none | 关键词检索 |
| artifact_submit | →workdir | low（doc 类默认审批，D13②） | 静态产物提交（写工作目录通道②） |
| workdir_edit | workdir | low | 代码受控编辑（diff 审计 + **任务级**聚合 artifact，写通道①，D14-⑧） |
| cmd_run | workdir | 视命令 | 命令执行器（写通道③；沙箱/风险/联网见 sandbox.md） |
| approval_query | 审批状态 | none | 查看自己触发的审批（审批请求由执行器自动产生，不由模型触发） |
| meeting_start | platform | none | 发起会议（主持人在其 user 会话回合调用） |
| meeting_advance / meeting_close | platform | none | 主持人**在其主持的会议会话内**推进议程/结束会议（tools.md §3 可用性规则） |
| meeting_ask_user | platform | none | 主持人请求用户拍板（question/options，会议转 blocked_waiting_user；meeting 会话内**仅主持人**可调，D18-①） |

> **任务工具（D15 → 2026-09-12 任务栏）**：`task_assign`/`task_claim`/`task_update` 作为**平台工具在 user 会话始终可用**（`PLATFORM_USER_TOOLS`）：`task_assign` 仅 pm/product 可调用（工具内校验角色），把任务**发布到任务栏**（`todo`=已发布·待领取）并通知受派人；受派人用 `task_claim` **领取**（只能领自己的、受单工槽位约束）后转 `in_progress`；`task_update` 汇报完成/受阻/终止，平台据此**通知委派人安排后续**。系统提示相应注入 `[待领取任务]`（引导 claim）、`[当前任务]`（要求 done 上报）与 `[任务栏（甲模式已开启）]`（pm/product 发布指引）。乙模式（`task.assignByAgent=false`）下 Agent 不能创建任务，任务由用户经 API/UI 发布。

**审批默认（D13②）**：doc 提交需审批；code 提交（workdir_edit 聚合）无需审批留痕即可；高危命令需审批。`cmd_run` 风险判定、cwd 锁定、危险清单与审批桥规则见 [sandbox.md](sandbox.md) §5（本节不再重复）。
**路径边界**：任何文件工具目标解析后必须落在「该 Agent 私有工作区 ∪ 项目工作目录」内（虚拟路径机制见 sandbox.md §3），否则拒绝并记 audit 事件（错误回注 agent 调整）；平台内置只读资源经 ro:// 显式开放。

## 7. 回合执行错误处理

- 模型/网络错误：指数退避重试 ≤3 次 → 仍失败则给用户可见错误消息并记录 error 事件。
- 工具越界/拒绝：以结构化 tool_result 返回（含原因），Agent 调整方案继续。
- 审批拒绝：tool_result 注明拒绝，Agent 需给替代方案或说明。
- 进程重启：进行中的回合以"未完成"记录，恢复后按策略续跑或让 Agent 总结中断点（memory.md §7 恢复）。
- **审批等待跨重启（M1 定稿）**：进程内工具命中审批 → Agent `waiting`，用户批准后执行器**续跑原调用**；若等待期间进程重启，该回合视为未完成（缺 `turn_end`），approval 记录（approvals.jsonl）保持 `pending`——用户决定写入 approvals 与会话 log，但不自动执行原动作；Agent 下次被触发时读取决定并自行决定是否重试（重试动作再次命中审批则需重新审批）。

## 8. 审计

- 全部 tool_call/tool_result、approval、artifact、state 事件已在 session log 中（统一真相源）。
- 界面"审计轨迹"= 按 kind 过滤的事件流；导出一键 JSONL。
