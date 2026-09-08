# Agent Haness · 文档索引

> 本地多 Agent 软件开发协作平台 —— 用户(老板)与一组可编排的 AI 研发角色(Agent)围绕软件项目协作。
> 文档状态：**v0.2 草稿(整体重写，按 2026-09-08 确认的新需求)**
> 本文档为 docs 目录唯一索引；正式文档一律按类别存放，不堆在根目录。

## 目录导航

| 类别 | 文档 | 内容 |
| --- | --- | --- |
| 需求 | [requirements/prd.md](requirements/prd.md) | 目标/用户故事/功能需求(MoSCoW)/已确认决策/边界/MVP/验收 |
| 设计 | [design/architecture.md](design/architecture.md) | 总体架构：进程/分层/模块/数据流/目录结构/扩展点 |
| 设计 | [design/data-storage.md](design/data-storage.md) | 纯文件系统存储：运行时项目文件夹/会话日志/记忆/索引/schema |
| 设计 | [design/agent-runtime.md](design/agent-runtime.md) | Agent 抽象：角色模板/loop 模板/模型路由/单工状态机/工具与审批 |
| 设计 | [design/sessions.md](design/sessions.md) | 会话模型：用户-角色会话/会议会话/生命周期/调度 |
| 设计 | [design/meetings.md](design/meetings.md) | 会议机制详设：发起/议程/异步轮次/阻塞等用户/插话/总结回写 |
| 设计 | [design/memory.md](design/memory.md) | 记忆设计：全文日志/摘要分层/全局与个人记忆/检索/中断恢复 |
| 设计 | [design/workspaces-artifacts.md](design/workspaces-artifacts.md) | 工作区隔离与产出物提交制 |
| 设计 | [design/tools.md](design/tools.md) | Agent 工具设计：注册表/内置清单/角色默认矩阵/调用协议/写通道 |
| 设计 | [design/sandbox.md](design/sandbox.md) | 沙箱与命令执行安全：路径边界/进程控制/风险分级/联网策略/审计 |
| 前端 | [frontend/style.md](frontend/style.md) | 页面结构/组件约定/交互规范(创建项目、三栏工作台) |
| 接口 | [api/contract.md](api/contract.md) | REST/WS 接口草案/事件/错误码 |
| 方案 | [plan/development.md](plan/development.md) | 里程碑/纵向切片/验证方式/风险 |
| 测试 | [testing/plan.md](testing/plan.md) | 测试分层/计划/验收方式 |
| 运维 | [operations/deploy.md](operations/deploy.md) | 环境要求/运行/配置/数据备份迁移 |
| 修改 | [changes/](changes/) | 修改记录(按日期) |

> 注：全部类别均为 `docs/` 的子目录（requirements/design/plan/changes/api/frontend/operations/testing），本索引中相对链接均相对本文件（docs/README.md）解析。

## 术语表（全库统一，严禁歧义）

| 术语 | 定义 |
| --- | --- |
| **平台** | Agent Haness 本体（本仓库，Node.js 服务 + Web 前端）。 |
| **用户 / 老板** | 平台使用者。每个软件项目的拥有者与最终决策者；不是 Agent。 |
| **项目 (Project)** | 一次软件开发协作的独立单元。一个项目 = 运行时项目文件夹(配置/日志/记忆/工作区) + 一个用户选定的**工作目录**(产出物)。 |
| **角色模板 (Role Template)** | 可复用、可添加的系统级定义：显示名/职责描述/系统提示词/默认模型/默认 loop/工具与权限集。内置 PM、产品、架构、交互、UI、开发、测试、运维等模板。 |
| **角色实例 (Role Instance / Agent / Worker)** | 角色模板在某个项目中的实例化。一个项目可自主组队：增删实例、改实例名、改提示词、换模型、换 loop。**文档中 Agent 均指项目内的角色实例**。 |
| **工作目录 (workdir)** | 创建项目时用户选择的目录：产出物(文档产物、代码)落在其中。可能是空目录，也可能是**已有代码仓库**。会话日志、记忆**不**存放在此。 |
| **运行时项目文件夹 (runtime dir)** | 平台数据目录下 `projects/<projectId>/`：project.json、会话日志、记忆、私有工作区、产出物 manifest、任务与审批记录。**拷贝该文件夹即迁移会话与记忆**。 |
| **私有工作区 (workspace)** | 运行时项目文件夹内每个 Agent 独占的子目录(草稿/笔记/临时文件)。其他 Agent 与用户 UI 不可见，Agent 间不直接共享。 |
| **共享产出物 (Artifact)** | 由某 Agent 通过**提交**动作进入工作目录的正式产出(文档/代码/配置/测试结果)。带署名、类型、版本、状态，可回退。 |
| **会话 (Session)** | 交流与协作的容器，分两类：`user`(用户↔单个 Agent 的 1:1 会话) 与 `meeting`(多方会议会话，含用户)。每会话有全量日志与元数据。 |
| **会议 (Meeting)** | Agent(主持人)发起的多方会话：发起者为主持人；用户恒为成员；**会议中只能沟通，不能执行产出性工作**。异步推进，需用户拍板时阻塞等待。 |
| **消息 (Message)** | 会话中的基本单元。分角色：`user`/`agent`/`system`/`tool` 轨迹事件；每条落盘为 session log 事件。 |
| **Agent 状态** | `idle 空闲 / working 工作中 / meeting 会议中 / waiting 等待中(等待用户输入或审批)`。MVP 为四态（D16-②）：Agent 级无 suspended；会话级 suspended（user 会话被会议占用/重启恢复期，occupancy 派生投影，D18-④）见 sessions.md。单工：一个 Agent 同一时刻只有一个活动会话。 |
| **任务 (Task)** | 用户或 PM 委派给某个 Agent 的工作项(轻量记录)：标题/受派者/状态/关联会话/关联产出物。 |
| **审批 (Approval)** | 需要用户确认的闸门：高危命令执行、以及按策略需要批准的产出物提交等。 |
| **产出物提交 (Submit)** | 私有工作区内容被整理为正式产出并写入工作目录的动作；记录 manifest 条目(署名/版本/文件清单/摘要)。 |
| **记忆 (Memory)** | 分三层：项目全局记忆(共享) / 角色记忆(个人) / 会话全量日志+摘要。见 memory.md。 |
| **工具 (Tool)** | Agent 影响外部世界的唯一受控通道，经注册表注册（schema/作用域/风险/审批/幂等）。命名 `<域>_<动作>`（如 fs_read_file/cmd_run/artifact_submit）。见 tools.md。 |
| **逻辑沙箱 (Sandbox)** | 进程/文件级安全边界（无 Docker 依赖）：虚拟路径(scheme)边界 + 命令执行控制 + 风险分级审批 + 审计。见 sandbox.md。 |
| **虚拟路径** | Agent 看到的逻辑路径 scheme：`ws://`(本人私有区) / `workdir://`(项目工作目录) / `ro://`(只读平台资源) / `runtime://`(平台独占)。 |
| **agent loop** | Agent 单轮回复的执行模式模板：单轮直答 / 反思自省 / 计划-执行 等；创建角色时选择，且每角色可配不同模型。 |
| **模型路由** | 把不同角色/loop 步骤映射到具体 LLM Provider(OpenAI 兼容/Ollama/Mock)的配置机制。 |

## 顶层目录约定（详见 architecture.md / data-storage.md）

```
agent_haness/                  # 平台仓库
├── config.yaml                # 平台级配置(端口/模型/数据目录/审批策略/默认角色库)
├── src/
│   ├── server/                # HTTP/WS/静态托管 表现层
│   ├── application/           # 应用服务(项目/团队/会话/会议/调度/产出物/审批/记忆/检索/模型网关)
│   ├── domain/                # 领域模型与状态机/规则(纯逻辑)
│   ├── infra/                 # 文件存储/模型 Provider/工具执行器/权限审批(落地)
│   └── shared/                # 常量/配置/错误码/日志
├── web/                       # React+Vite 前端
├── docs/                      # 本文档库
└── data/                      # 运行时数据(不入库): projects/<projectId>/ 等
```

## 核心需求速览（详见 prd.md）

1. 用户是老板：每个 Agent 有独立会话，用户可任意聊天、委派、插话、审批、拍板。
2. 独立 PM Agent 负责进度协调与组织会议（MVP 默认不直接创建/指派任务：任务由用户经 UI 驱动；PM 结构化拆解能力=task_* 工具组已实现但默认关闭，可按配置开启对比，D15）；角色模板可增删改。
3. Agent 可发起**多人会议**(新会话)，主持人是发起者；会议异步推进，需用户决策时阻塞等用户，用户可随时插话；会议内只沟通不干活。
4. 每会话有全量 session log + 双层记忆(摘要/长期条目)，支持上下文构建与中断恢复；会议结束生成摘要回写各参与者。
5. 项目选**工作目录**(产出物所在)，session log/记忆**不在**其中；Agent 私有工作区隔离，产出走**提交制**进工作目录。
6. 三栏工作台：左 Agent 列表(含状态) · 中会话窗口 · 右会话列表；另有创建/管理项目页与角色库管理。
7. 系统级角色库 + 项目级组队；创建角色可配提示词、内置 agent loop 与模型。
8. 技术栈 Node.js+TS+React(Vite)；**不用 SQLite**，纯文件系统存储，拷贝即迁移；本地部署。

## 已确认决策记录（2026-09-08）

见 [prd.md](requirements/prd.md) §7：**D1~D18**（两轮问答 + 四轮文档评审定案：D13 代码产出/审批默认值、D14 默认团队/产出布局/多实例/日志时间线/会议邀请与并发/流式语义/产物聚合/实例停用/会议读取、D15 PM 定位与任务通道、D16 会议状态与排队持久化/suspended 收敛/plan 回合语义/任务激活规则/模板快照/doc 审批预览、D17 任务激活不抢占与终止/会议转台通知分级/需你处理队列/doc 审批降噪与信任/未完成回合恢复/停止生成与活动区范围、D18 评审轮4 抽象设计定案：meeting_ask_user 会议拍板工具/Agent 检索可见性/任务唤醒与队列游标/occupancy 单真相/双写主从与纪要可重放/端口清单与单一事件规范/PolicyEngine）。设计文档不得与决策表冲突；未决项见 prd §10（U1/U5）。

## 文档写作约定

- 中文撰写；文件名英文小写；一个文档一个职责。
- 未决项一律写入 prd.md 的「未决清单」，不允许在正文中含糊带过。
- 状态标记：`草稿`(待评审) / `已评审` / `过期`。
- 修改必须追加 docs/changes/ 记录（含日期/范围/验证）。
