# 总体架构设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 关联：[prd.md](../requirements/prd.md)、[data-storage.md](data-storage.md)、[agent-runtime.md](agent-runtime.md)

## 1. 设计原则

- **文档/代码/数据一律可拷贝迁移**：无外部 DB；运行时数据=文件夹。
- **Agent 单工**：调度层保证一个 Agent 同一时刻只有一个活动会话被处理。
- **安全边界默认最小**：Agent 的文件与命令活动被限制在项目工作目录（+只读平台资源）；写入另受文件归属约束（只能改自己名下或无归属的文件）；高危必须审批，全程审计。
- **核心逻辑与 IO/框架解耦**：domain 层纯逻辑可单测；存储/模型/工具都是可替换端口。
- **扩展靠接口不靠配置爆炸**：角色、loop、模型、工具、产出物类型、前端面板各有稳定扩展点。
- **进程内一切可见**：单一 Node 进程承载全部（HTTP/WS/调度/Agent 执行），本地部署优先简单可靠。

## 2. 技术栈

| 层 | 选型 |
| --- | --- |
| 语言/运行时 | TypeScript + Node.js ≥ 20 |
| HTTP/WS 服务 | Fastify（REST + 静态托管 + @fastify/websocket 或 ws） |
| 前端 | React 19 + Vite 8 + Ant Design 6（聊天/工作台组件；画布候选 React Flow）；构建产物 `web/dist`，由 Fastify 单端口托管 |
| 实时通道 | WebSocket（事件推送 + 消息流式 chunk）；无 SSE 时退回轮询（不推荐） |
| 模型 Provider | 四种协议适配器：`openai-compatible` / `anthropic` / `gemini` / `ollama`（**自研轻量网关，不引重型 SDK 依赖**，便于换后端）；供应商与模型条目由用户在 UI 配置（D20 / [model-config.md](model-config.md)） |
| 存储 | 纯文件系统 + 手写 JSONL/JSON/Markdown 读写层 + 自建关键词倒排索引 |
| 测试 | Vitest（单元+集成，模型替身保证可重复） |
| 配置 | `.env`（平台级引导与边界默认，2026-09-13 起替代 config.yaml；模板 `.env.example`）+ **`data/model-config.json`（平台模型配置，UI 可改、即时生效）** + project.json（项目级）+ role 模板文件 |

## 3. 进程与部署形态

```
[浏览器 UI]──(REST/WS)──▶[Node 单进程]
                            ├─ HTTP 层：REST + WS + 静态资源(web/dist)
                            ├─ 应用层：调度/会话/记忆/审批…
                            ├─ 领域层：状态机/规则/模型
                            └─ 基础设施：文件存储/模型网关/工具执行器/审批器
开发模式：npm run dev  =  server(:3000) + vite(:5173，代理 API)
生产模式：npm run build → npm run start  =  单端口 :3000
```

无后台任务守护需求（本机使用）。重启即可从磁盘恢复（会话状态/记忆全落盘）。

## 4. 分层模块（src/）

```
src/
├── server/
│   ├── http-routes/        # REST：projects/sessions/messages/artifacts/tasks/roles/approvals/search/fsbrowse
│   ├── ws/                 # WS 网关：事件订阅、上行命令、下行推送(消息 chunk/状态/审批)
│   └── static.ts           # 托管 web/dist
├── application/
│   ├── project/            # 项目 CRUD、创建向导、工作目录校验(空/仓库嗅探)、删除
│   ├── team/               # 角色库(模板 CRUD) + 项目实例管理、实例配置(提示词/模型/loop)
│   ├── orchestration/      # 项目编排图：节点/边校验、保存、委派约束判定（D19-④）
│   ├── tool-package/       # 工具包元数据与挂载（MVP 只读展示，D19-②）
│   ├── session/            # 会话聚合：user 会话、会话生命周期、消息追加/读取、恢复加载
│   ├── dispatcher/         # 单工调度：Agent 状态机、活动会话独占、排队、恢复
│   ├── agent-loop/         # loop 执行器：strategy 注册表 + 执行上下文(记忆窗口/工具/模型路由)
│   ├── memory/             # 记忆服务：全文日志写入、摘要引擎、长期条目、全局记忆、检索
│   ├── artifact/           # 提交制：manifest、提交/回退/审计
│   ├── task/               # 轻量任务委派与状态
│   ├── approval/           # 审批队列(高危命令/策略提交) 与策略解析
│   ├── search/             # 关键词检索(索引维护+查询)
│   ├── model-config/       # 模型供应商/模型条目/路由的增删改查、连通性测试与发现（D20）
│   └── model-gateway/      # 模型路由与统一调用(流式)
├── domain/
│   ├── models/             # Project/Team/Agent/Instance/Session/Message/Artifact/Task…(纯类型+行为)
│   ├── fsm/                # agent 状态机、session 状态机（纯函数，单测重点）
│   ├── rules/              # 目录边界、高危清单、审批策略（PolicyEngine，D18-⑥）、产出物类型注册、可见性规则（读/检索，D18-②）（纯函数）
│   └── events/             # 领域事件定义（落日志/通知的统一事件）
├── infra/
│   ├── file-store/         # JSON/JSONL/MD 读写、原子写、path 边界校验、watch(工作目录变化)
│   ├── indexer/            # 倒排索引构建/增量/查询
│   ├── model/              # providers: openai-compatible/anthropic/gemini/ollama + 流式归一化（D20）
│   ├── tools/              # 工具注册表与执行器（注册/校验/白名单/审计；规范见 design/tools.md）
│   ├── sandbox/            # 逻辑沙箱：路径边界/命令执行器/风险分级/审批桥（规范见 design/sandbox.md）
│   └── util/               # 日志、id、时间、错误码
└── shared/                 # 常量/错误码/配置加载/类型
```

### 4.1 核心端口清单（domain+shared 只依赖接口，infra 实现；D18-⑤c）

> **完整抽象契约见 [abstraction.md](abstraction.md)**：本表只列最关键的 7 个端口；分层依赖规则、全部端口（存储/模型/执行/策略/平台）、DI 容器与生命周期、设计模式清单、扩展点操作手册、目标目录结构以该文件为准。

| 端口 | 职责 | 默认实现 |
| --- | --- | --- |
| `SessionLogStore` | 会话事件日志追加/按 seq 窗口读取/轮转 | infra/file-store |
| `MemoryStore` | L3 记忆条目读写（global/角色） | infra/file-store |
| `FileStore` | 原子写/路径边界/编辑会话锁/工作目录 watch | infra/file-store |
| `ModelGateway` | Provider 路由与统一流式调用 | infra/model |
| `ToolExecutor` | 工具注册/校验链/审批桥/审计 | infra/tools |
| `PolicyEngine` | allow/approval/deny 判定（D18-⑥） | domain/rules 纯函数 |
| `PathResolver` | 虚拟路径解析与边界校验 | infra/sandbox |

- 启动装载顺序：config → FileStore/SessionLogStore/MemoryStore → PolicyEngine/PathResolver → ModelGateway → 各注册表（tool/loop/artifact type）→ dispatcher 等服务；全部端口可注入替身（Vitest，M 系列单测基础）。

## 5. 关键数据流

### 5.1 用户消息 → Agent 回复（单工主链路）

```
UI 发送消息 → session service 校验会话归属与 Agent 可调度性
  → dispatcher：Agent 状态 busy 则排队（提示用户"正在工作"）
  → 获得处理权：组装上下文（session 全量窗口 + 摘要 + 角色记忆 + 全局记忆 + 工作目录产出索引）
  → agent-loop 按角色所选 strategy 执行（每步=调模型/调工具/落轨迹事件）
        ├─ 工具调用 → tool executor（边界/白名单/审批桥）→ 结果回注 loop
        └─ 每产生一条事件（thought/text/tool/artifactRef）→ WS 推前端 + 写 session log
  → loop 结束（写入 turn_end）→ 触发记忆维护（滚动摘要/长期条目提取）→ dispatcher 释放 Agent
  → plan-execute = 单回合多步长跑（D16-③）：回合内被审批（waiting）或用户终止任务（可中断点）暂停时，恢复由 dispatcher 在**同一会话内**续跑（plan 事件为断点依据，重启**不自动续跑**——缺 turn_end=未完成，用户下一条消息触发 Agent 汇报/续做，memory.md §6）
```

### 5.2 产出物提交制

```
Agent 在项目工作目录内直接产出（经 workdir_edit 受控编辑；目录内容全员可读、仅归属者可改）
  → Agent 显式登记(artifact_submit)：填写类型/标题/摘要/文件清单
  → 登记执行：按策略判断是否需审批 → 版本内容落 artifact-versions（快照/补丁）
  → manifest 落运行时项目文件夹（署名/版本/状态/文件清单/回退指针）
  → 事件推送：会话消息 + 右栏产出物列表更新
```

### 5.2b 委派与领取（D19-④⑤，详见 orchestration.md）

```
用户在 Agent A 的会话发消息（＝让 A 开工）
  → A 在自己的回合内调用 task_assign：目标必须是编排图出边节点（否则 ERR_ORCHESTRATION_EDGE）
  → 任务落任务栏（todo）+ 通知受派者 B（WS task.updated）
  → B 领取（task_claim）→ in_progress（每 Agent 至多 1 个，激活即唤醒）
  → B 独立执行（可继续沿自己的出边向下游委派）
  → B 完成/受阻 → task_update 汇报给派发者 A（沿同一条边反向）
  → 全过程在画布节点徽标与右栏任务列表可见；无项目级运行状态、无自动接力
```

## 6. 领域模型总览（详见 data-storage.md）

```
Project ─┬─ Team ── RoleInstance(Agent) ─┬─ 配置: templateRef/prompt/modelId/loopId/tools/enabled
         │                               │      （MVP 每模板至多 1 实例，D14-3；enabled=false=停用保留数据，D14-9）
         │                               ├─ 状态(单工) + 活动会话指针
         │                               └─ 角色记忆
         ├─ workdir(用户选定) ── 产出物落地
         ├─ Sessions ── Session{type: user, participants, state, logFile, metaFile}
         ├─ Tasks
         ├─ Artifacts(manifest)
         ├─ Approvals(队列/历史)
         └─ 全局记忆 + 检索索引
```

## 7. 一致性、异常与恢复

| 场景 | 策略 |
| --- | --- |
| 服务中途退出 | 所有状态以磁盘为准：会话 meta 记录"进行中"，重启时 dispatcher 重建；未完成工具序列按 loop 断点标记为可重试/作废（记录在 log）。 |
| 浏览器刷新/断开 | WS 断线重连 + 全量历史拉取（页面无状态，恢复由服务端提供）。 |
| Agent 长任务中用户发消息 | 入队；当前回合结束(可中断点)后处理；状态提示"工作中"。 |
| 工具/模型调用失败 | 事件记录错误 → 重试(幂等工具)/降级答复；不静默丢上下文。 |
| 并发写文件 | 单进程内所有写经 file-store 原子写(临时文件+rename)；Agent 回合串行化天然避免同 Agent 冲突；跨 Agent 写同一文件由 `file-owners` 归属校验挡住（非 owner 拒改 `ERR_FORBIDDEN`）。 |
| 工作目录被外部修改 | 提供手动刷新(watch 可选)；写入用相对路径+存在性校验防覆盖冲突。 |
| 审批超时/拒绝 | 拒绝=动作不执行并回注给 Agent 调整方案；超时策略=按配置默认拒绝或挂起提醒。 |
| 审批等待跨重启（M1） | approval 保持 pending，用户决定落盘但不回放执行；Agent 恢复时读取决定自行决定重试（重试需重新审批）。见 agent-runtime §7。 |
| 停用忙碌实例（B6/D16） | enabled=false 后 dispatcher 不再领新活；working 中的实例进入"待停用"，到可中断点/自然结束后生效（UI 提示）；waiting（审批等待）实例先处理/取消审批再停用。见 agent-runtime §2。 |
| 删除项目（仅运行时数据） | 删除前校验：无运行中子进程/进行中回合/pending 审批；有则要求先结束，或用户确认强制（杀子进程、pending 审批置 expired、未完成回合按"未完成"归档）；不影响用户工作目录（prd FR-01）。 |

## 8. 安全边界（详见 agent-runtime.md）

- 路径边界：Agent 可写 = `项目工作目录`内**归属自己或无归属**的文件；可读 = 项目工作目录全部 + 内置只读资源；**越界路径一律拒绝并审计**。
- 命令边界：仅在项目工作目录内执行；危险命令清单（rm -rf/覆盖安装/改全局配置/网络代理等）进审批。
- 审批：由用户（仅本机单用户）确认；拒绝/批准都作为事件写入 session log。
- 审计：所有工具调用（含参数摘要）与审批决定写入日志，界面可查"审计轨迹"。

## 9. 扩展点清单

| 扩展点 | 机制 |
| --- | --- |
| 角色模板 | 系统角色库：模板文件（提示词/默认模型/默认 loop/工具集/权限）可增删。 |
| agent loop | `agent-loop` strategy 注册表：实现统一接口(strategyName, buildSteps)，配置即用。 |
| 模型 Provider | `infra/model/providers/` 五实现 + `ProviderKindRegistry` 注册表；供应商/模型条目/默认路由由 UI 写入 `data/model-config.json`（`ModelConfigStore`），改完即时生效、不重启（[model-config.md](model-config.md)）。 |
| 工具 | tools 注册表（名称/schema/实现/白名单级别/是否高危）。 |
| 产出物类型 | 类型注册表（文档/代码/配置/测试/部署…）：默认路径、校验、diff 器。 |
| 审批策略 | 规则函数：按命令/动作/类型/范围返回 needApproval 布尔。 |
| 场景模板（远期） | 打包"角色集+产出类型+流程"，见 prd FR-21。 |

## 10. 端口与接口约定（详见 api/contract.md）

- REST：`/api/projects`、`/api/projects/:id/team|sessions|artifacts|tasks|questions|approvals|search|orchestration`、`/api/projects/:pid/agents/:iid/{pause,resume,stop}`、`/api/agent-templates`（含写路径）、`/api/tool-packages`、`/api/fs/browse`(目录选择)、`/api/config`、**`/api/model-presets|model-providers|models|model-routing|model-config/import`（D20 模型配置）**
- WS：`/ws` 事件推送（见 contract.md）；文本协议 JSON。
- 全部错误返回统一 `{ code, message }`。

## 11. 与前端页面的对应

| 页面 | 对应服务 |
| --- | --- |
| 首页 · 项目模块（列表 + 创建向导：选工作目录 + 勾选角色） | project/team + fs/browse |
| 首页 · Agent 模块（模板库：loop/提示词/工具/模型/场景；**提示词/loop/模型可提交**，工具只读） | team(模板) + model-config(模型条目) + tool-package |
| 首页 · 模型模块（供应商/模型条目/默认路由/连通性测试） | model-config + ws |
| 首页 · 工具模块（7 个基础包展示，只读） | tool-package |
| 项目页 · 拓扑导航（**2 栏**：左画布 + 右三列表） | orchestration + agent.state + ws |
| 项目页 · 对话导航（**3 栏**：左会话切换 + 中会话流含工作日志 + 右三列表） | session + ws |
| 右栏三列表（任务 / 询问 / 审批） | task / question / approval |
| 产出物/任务/审批面板 | artifact/task/approval |
