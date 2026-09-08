# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 评审轮 4：代码抽象设计评审（架构师视角，未改动设计正文）

- 需求/问题: 以架构设计师身份对全套设计文档做「抽象设计评审」——审查核心抽象（角色三层、会话/会议状态机、事件模型、记忆分层、工具/沙箱、调度、双写与恢复）的边界合理性、职责划分、一致性风险与过度/不足设计，输出缺陷清单与改进建议。
- 类型: 文档(评审报告，新增)。评审输出阶段未改动 design/ 正文与 prd 决策表；**定案与落档见本文件末尾「2026-09-08 评审轮 4 定案（R1~R6 全部采纳推荐）」一节**。
- 方法: 通读 prd(D1~D17/U1/U5)、architecture、agent-runtime、sessions、meetings、memory、tools、sandbox、data-storage、workspaces-artifacts、api/contract、frontend/style、plan/development 及前 3 轮修改记录；再以 grep 交叉核实疑点（工具注册表缺 meeting.request_user_decision、点号/蛇形命名混用、maxIter vs maxIterations、workdir 绝对路径与存储原则冲突、可见性规则是否作用于 Agent 侧检索等）。
- 总体评价（先说结论）:
  - 抽象成熟度高：工具=Agent 影响外部唯一通道 + 三条受控写通道、虚拟路径沙箱 L0~L3、Agent 单工、模板快照实例化、L1 全量日志为真相源、"索引/runtime.state 可重建"的派生数据纪律，是一套自洽且防守扎实的设计，明显优于多数同类方案。
  - 结构性风险集中在五点：①「谁是真相源」原则未被贯彻到全部状态（会话 meta 双轨、业务记录与 log 双写无对账）；②"事件"存在三套词汇且无规范映射；③安全/可见性规则（记忆私有、会话私密）没有统一挂到工具执行链；④暂停/恢复/唤醒语义停留在叙事层，未收敛为接口级契约；⑤会议决策点等少数动作游离在工具注册表之外。

### 一、H 级缺陷（会咬到实现 / 存在越权或丢数风险，建议定案后必改）

| # | 缺陷 | 证据（文件 §） | 后果 | 改进建议 |
| --- | --- | --- | --- | --- |
| H-1 | **「请求用户拍板」未落工具注册表，会议工具命名两套** | meetings.md §5「发言人调用 `meeting.request_user_decision(question, options?, contextRefs)`」、§3「调用 `meeting.start`」；tools.md §3 仅注册 meeting_start/advance/close；meetings.md §8 降级清单亦无该动作；tools.md §2 命名规范为 `<域>_<动作>` | 实现期无法判定它是模型工具还是系统服务；调用权限（仅主持人 or 任一成员）未定义；进入 `blocked_waiting_user` 的唯一入口缺失，D17-③「需你处理」联动断链 | 在 tools.md 注册 `meeting_ask_user`（scope=platform，availableIn=meeting，**仅主持人**可调）；成员需拍板→发言请主持人升格，避免多决策点叠加；meetings.md §5 叙述同步改名；规定同一时刻至多一个 pending 决策点 |
| H-2 | **Agent 侧检索未复用可见性规则 → 越权读他人会话/记忆的侧信道** | memory.md §1 可见性（user 会话日志仅双方可读、角色记忆私有）；meetings.md §8 会议内可用 `session_search`（tools.md 描述为"本项目会话日志"）且未声明可见性过滤；fs/ws 路径隔离完整（sandbox §3），唯独检索服务未套同一规则 | 会议中任一 Agent 可经 session_search 读出他人 user 会话内容（含 thought/工具细节），绕过"记忆私有、无 Agent 间私聊"的产品约束 | 定义「Agent 可检索集」= 本人 user 会话 ∪ 已入/参与的 meeting 会话 ∪ 全局记忆 ∪ 本人角色记忆；检索与直接读共用同一 visibility 纯函数（domain/rules）；用户侧检索不受限（H 级安全项） |
| H-3 | **业务记录文件与 session log「双写」无一致性/恢复协议** | agent-runtime §8 / data-storage §7 / memory §7："审批落 approvals.jsonl + 会话 log（audit 双写）"、"双写一致性由事件总线保证"；纯文件无事务 | 崩溃窗口内一写成功一写失败 → 业务状态与审计不一致且无对账手段；search-index/runtime.state 都声明"可重建"，唯独这几类没有 | 定义主从顺序：业务状态文件原子写成功=事实生效，log 事件追加为审计投影（失败仅记自检告警）；或反向并声明另一侧为"可重建投影"。启动自检对账 log 尾部补齐缺失记录；在 data-storage §7 明确该协议 |
| H-4 | **Agent 占用真相双轨 + 入会"扇出更新"** | agent-runtime §2：runtime.state(cache)；sessions.md §2：user 会话 meta.state=suspended 持久化；重启"均按 meta 恢复" | Agent 入会需同步改 runtime.state + 主持人/每成员 user 会话 meta + meeting meta；任一处漏写/崩溃 → 重建依据与真实占用不符，状态机双源漂移 | 单一占用真相 = dispatcher 持久化的 occupancy（agentId→活动{type,sessionId}，小文件、可重建）；user 会话 suspended 降为派生投影（渲染时按 occupancy 计算），启动一次性重算；"写 N 个 meta"→"改 1 个真相" |
| H-5 | **摘要/纪要生成器 = 第二条模型调用链，close 后无失败重试语义** | memory.md §3（摘要引擎模型生成）；meetings.md §7（close→纪要→写记忆+summary 事件）；data-storage §4.2 | close 后引擎失败/进程重启 → 纪要永久丢失且无 pending 标记可补跑（L1 日志虽在，系统不会自动重生成）；该生成器的生命周期/审计口径未定义 | 把纪要定义为 **L1 的派生视图**：生成器幂等、输入=closed 会话全量 log，随时可重放重生成；close 流程先置 minutesPending 再产出，UI 提供"重新生成纪要"；摘要引擎同理标注为可重建派生 |
| H-6 | **队列/唤醒语义缺口：任务激活与重启后残留消息无自动唤醒** | agent-runtime §4（in_progress 注入任务）；prd FR-08/US-3（用户经 UI 指派）；agent-runtime §3/D16-③（跨重启不自动续跑，用户下条消息触发） | a) 用户置任务 in_progress 后 Agent 空闲却无任何输入 → 可能永不开始（依赖用户再发消息，与"委派即开工"直觉相悖）；b) 重启后队列残留未处理 user 消息而 Agent 又无未完成回合 → 静默滞留 | 定义任务激活副作用：置 in_progress = dispatcher 向受派者 user 会话入一条系统/用户消息"请开始执行任务 t_…"；引入 per-agent 处理游标 lastHandledSeq 落盘，启动时"队列非空且无占用"的 Agent 自动补一轮或 UI 强提示——注意与"未完成回合不自动续跑"语义区分（排队消息 vs 回合断点） |

### 二、M 级问题（抽象职责/一致性风险，建议定稿前收敛）

| # | 问题 | 建议 |
| --- | --- | --- |
| M-1 | 架构 §1 宣称"存储/模型/工具都是可替换端口"、domain 纯逻辑可单测，但**全文无任何 app→infra 端口接口清单**；loop/tool/model/artifact-type/approval-rule 多个注册表零散分布 | 增加"端口清单"一节：`SessionLogStore / MemoryStore / FileStore / ModelGateway / ToolExecutor / PolicyEngine / PathResolver`；规定 domain+shared 只依赖接口，infra 实现，注册表统一装载顺序并可注入 Mock |
| M-2 | **三套"事件"词汇并行**：会话 log kind（turn_start/message/…，data-storage §4.2）、WS 下行事件（message.chunk/session.updated/…，contract §3）、错误码（ERR_* + 内部简码，仅错误码做了映射） | 收敛为**单一规范事件 schema**（kind+payload+scope: session/project/agent），会话 log 落盘、WS 推送、索引/摘要、待办条/通知都是它的投影；避免实现期三份枚举各自漂移 |
| M-3 | loop runner 与 dispatcher 的**暂停/恢复/终止没有接口级定义**：plan-execute 长跑、三类暂停（审批/会议抢占/用户终止到可中断点）、同会话续跑，全部停留在叙事层 | 定义 `AgentTurn` 执行单元状态机：created→running→paused(waiting_approval \| preempted \| stopping)→done/aborted，配 pause/resume/cancel/terminate 事件契约；纳入 domain/fsm 纯函数与单测 |
| M-4 | **审批/策略入口分散**：tool 元数据 needsApproval + sandbox L2 命令风险表 + project.json artifactPolicy/approvalPolicy + D17-④ 信任开关（+P1"记住放行"）四处并存 | 收敛为单一 `PolicyEngine`：输入 (actor, sessionType, tool\|command, params, projectPolicy, trust) → allow\|approval\|deny + ruleId；tools/sandbox/project 只是数据源；文档明示判定优先级（deny > approval > allow） |
| M-5 | 存储原则 6「绝对路径只在运行时解析」与 project.json「workdir 存绝对路径」直接冲突 | 原则注明例外：workdir 是用户选定目录的**标识**必须绝对，其余对外引用一律相对化；避免实现者误把会话文件路径也存绝对 |
| M-6 | task.creator / sessionId 语义：任务记录 `sessionId` 与「会议纪要转出任务挂 source=本会议」两个引用关系未区分（data-storage §7、meetings §7） | 明确任务上的两个字段：`sessionId`=执行会话（受派者 user 会话），`sourceRef`=来源（会议/产出物/空），避免一处字段两用 |

### 三、L 级小项（措辞/命名/体验缺口，顺手修正）

| # | 小项 | 位置 |
| --- | --- | --- |
| L-1 | reflective 参数写 `maxIter(=2)`，通用参数表却叫 `maxIterations` | agent-runtime.md §3 |
| L-2 | development.md M0「monorepo 单仓结构」与 architecture「单一 Node 进程/单仓库」术语混用 | plan/development.md §2 |
| L-3 | 「用户随时进出（UI 层不阻塞）」与「用户恒为成员/不能缺席/离会不可」表述矛盾 | meetings.md §1/§2 vs §2 末段/frontend §4 |
| L-4 | proposed 征询期若全员拒绝且主持人遗忘 → 会议永久占槽，queued 队列被卡；只有"可取消"，无超时提醒 | meetings.md §2、sessions.md §2 |
| L-5 | plan-execute 无任务场景"按回合兜底"聚合：长回合数十步才 turn_end，可能把多块无关改动 lump 成一个 artifact，回退粒度粗 | workspaces-artifacts.md §2.2 |
| L-6 | code 版本用补丁链，跨 artifact 重叠编辑时逆序回退必然冲突（已有前置校验兜底）；可选：结算时另存受影响文件基线 hash 供快速冲突检测 | workspaces-artifacts.md §3 |
| L-7 | 产出物类型注册表（服务端）与 blocks 渲染器注册表（前端）双端同步无契约；远期场景模板应下发 schema 驱动 UI | architecture §9、frontend §6、tools §7 |

### 四、已确认的设计亮点（评审保留项，勿在重构中回退）

1. 工具=唯一受控通道 + 写 workdir 仅三条受控通道（tools.md §1/§6），防呆总纲清晰；
2. 虚拟路径 scheme + L0 是底线而非放权（allowedRoots 收窄），边界模型正确；
3. 单工 + 会话状态按类型分列 + Agent 四态收敛（D16-②），心智负担克制；
4. 实例创建时快照模板默认值（D16-⑤），避免模板变更涟漪，代价（无批量更新路径）可接受并在 UI 表达；
5. L1 事件日志为真相源 + search-index/runtime.state 声明为可重建派生——**应把同一条纪律推广到 H-3/H-4/H-5**。

### 五、待用户确认的采纳清单（确认后按前几轮惯例落决策表/正文）

- R1（H-1）补 `meeting_ask_user` 工具并限定主持人；meetings.md §5 改述——**需产品确认**"成员想请求用户拍板时是否只能经主持人升格"（与 D2"发言人可阻塞"存在张力，当前文档让"发言人"直接触发，建议收敛为主持人，避免全员可卡会）。
- R2（H-2）Agent 侧检索可见性集 —— 需确认"会议内成员是否可检索其他成员的公开产出/全局记忆之外的任何内容"（当前建议：不可）。
- R3（H-6）任务激活即唤醒 + 重启后排队消息自动补一轮 —— 需确认是否接受"比 D16-③ 更强的自动恢复语义"（注意它只恢复**排队消息处理**，不自动续跑未完成回合）。
- R4（H-4）occupancy 单真相 + suspended 派生化 —— 触及 D16-② 表述，需确认是否修订会话 meta 持久化口径。
- R5（H-3/H-5/M-1/M-2）双写协议、纪要可重放、端口清单、单一事件规范 —— 纯实现约定，建议随 M0~M1 落 code 前定稿。
- R6（M-4）PolicyEngine 收敛 —— 若接受，需把 sandbox §5/project.json/tools 元数据三处改写为"数据源"口径。

- 行为变化: 无（纯文档阶段；本报告未改正文）。
- 关键文件: 本文件（docs/changes/2026-09-08-docs-review-round4.md）新增。
- 验证: 本报告引用的每条证据均经 read/grep 原文核实（如 tools.md 无 request_user_decision、meetings.md §5 点号调用、agent-runtime §3 maxIter 双名、data-storage §1/§3 workdir 绝对路径、memory §1 可见性 vs tools 检索范围）；未对 design/ 正文与 prd 做任何改动。
- 测试: 无（文档阶段）。

## 2026-09-08 评审轮 4 定案（R1~R6 用户全部采纳推荐方案，正文落档）

- 需求/问题: 对评审轮 4 报告的 R1~R6 逐一定案；用户全部采纳推荐方案 → 新增决策 D18 并把口径落进相关设计文档。
- 类型: 文档(变更/定稿)
- 决策（新增，见 prd §7 D18）:
  - D18-① 会议拍板工具 `meeting_ask_user`（meeting 内仅主持人；成员需拍板先请主持人升格；至多 1 个 pending 决策点；meeting.start 统一为 meeting_start）；
  - D18-② Agent 侧检索可见性：session_search/memory_search 与直接读共用可见性纯函数；可检索集=本人 user 会话 ∪ 已参与会议 ∪ 全局记忆 ∪ 本人角色记忆；用户侧不受限；
  - D18-③ 唤醒语义：置 in_progress=注入唤醒消息；per-agent 游标 lastHandledSeq；重启后"队列非空且无占用"自动补一轮/提示（不续跑未完成回合，D16-③ 边界澄清）；
  - D18-④ 占用真相单轨：dispatcher occupancy 为运行期唯一真相（runtime.state 落盘、启动重建基线），user 会话 suspended 降为派生投影；
  - D18-⑤ 四项实现约定：a)业务记录文件先原子写、log 追加为审计投影＋启动自检对账；b)纪要/摘要=L1 可重放派生视图（minutesPending＋可重新生成）；c)核心端口清单（SessionLogStore/MemoryStore/FileStore/ModelGateway/ToolExecutor/PolicyEngine/PathResolver）；d)单一事件规范（kind+payload+scope，log/WS/索引/待办条皆为投影）；
  - D18-⑥ 统一 PolicyEngine：tools needsApproval、sandbox 风险表、project.json 策略、信任开关均为数据源；优先级 deny＞approval＞allow。
- 改动范围（关键文件）:
  - prd.md：§7 新增 D18 行；docs/README.md：决策索引 D1~D17→D1~D18（两轮问答+四轮评审）。
  - design/agent-runtime.md：§2 状态持久化改 occupancy 单真相（suspended 派生）、两级状态映射补 D18-④；§3 长任务注补排队消息恢复（D18-③）；§4 任务上下文补"激活即唤醒"；§6 工具概要表新增 meeting_ask_user 行。
  - design/sessions.md：§2 补 suspended 派生投影注；§3 入会挂起改"occupancy 派生"表述。
  - design/meetings.md：§3 meeting.start→meeting_start；§5 决策点改主持人调 meeting_ask_user＋单决策点约束；§7 补纪要=可重放派生视图（minutesPending）；§8 主持人专用工具补 meeting_ask_user。
  - design/memory.md：§1 可见性补"检索同等可见（D18-②）"；§3.2 补纪要可重生成。
  - design/tools.md：§2 补统一策略引擎（D18-⑥）；§3 工具表新增 meeting_ask_user 行、session_search 描述补可见性约束、主持人例外补工具与单决策点约束；§4 矩阵会议行加 ask_user。
  - design/sandbox.md：§5.1 补统一策略入口说明（PolicyEngine 数据源＋优先级）。
  - design/data-storage.md：§2 runtime.state 注释补 occupancy；§4.1 meta 注释补 suspended 派生；§4.2 补单一事件规范注；§7 补双写主从与对账注。
  - design/architecture.md：§4 rules 行补 PolicyEngine/可见性；新增 §4.1 核心端口清单；domain 树规则描述同步。
  - api/contract.md：§3 补 WS 事件=规范事件 UI 投影注。
- 行为变化: 无（纯文档阶段）。文档口径变更：meeting_ask_user 替代"发言人 meeting.request_user_decision"；Agent 检索受可见性约束；任务激活即唤醒＋队列游标恢复；suspended/占用状态单真相化（修订 D16-② 落盘口径）；双写主从＋纪要可重放；端口清单与单一事件规范定稿；策略判定收敛 PolicyEngine。
- 验证: prd §7 D18 与 docs/README 决策索引一致；正文 grep 无残留旧口径（meeting.request_user_decision/meeting.start/「meta.state=suspended 为真相」等）；D18 各编号在正文出现位置与决策行一一对应；未决清单仍仅 U1/U5。
- 测试: 无（文档阶段；testing/plan.md 规则补充列为 M 后续编码项）。
