# Agent Haness · 本地多 Agent 软件开发协作平台

> **当前状态：M0~M8 已交付（2026-09-08 编码完成轮次 1）；默认真实模型 deepseek-v4-flash；think 展示、甲模式任务分派、Agent 工具循环已落地（2026-09-09）。**
> 代码可运行、116 用例测试全绿；详见 [docs/plan/development.md](docs/plan/development.md) 与 [docs/changes/](docs/changes/)。

一个**本地运行**的软件开发协作平台：用户以"老板"身份，与一组可自由编排的 AI 研发角色（Agent）组成虚拟团队，通过**一对一会话**与**多方会议**协作，把软件项目从想法推进到可运行、可部署的产出物。

平台定位是可扩展的"角色 + 团队 + 场景"引擎，首个内置场景为**软件开发**；角色模板、agent loop、模型均可配置与扩展，后续可套用到任意协作场景。

## 快速开始

```bash
npm install
npm run dev        # 服务 :3000（含前端工作台 web/）；浏览器开 http://127.0.0.1:3000
npm run test       # Vitest 全量（116 用例）
npm run build && npm start   # 生产：tsc 编译后单端口运行
```

- 首次使用：点「新建项目」→ 填项目名与**工作目录（绝对路径，可用「选择文件夹…」）** → 勾选角色 → 创建后即可与角色对话。
- **默认模型 = deepseek-v4-flash（真实模型）**：启动前设置环境变量 `$env:DEEPSEEK_API_KEY = "sk-…"`；新建的角色实例默认走真实模型（`config.yaml models.default`，模板默认 mock 占位会自动落到平台默认）。
- 无 Key 想离线演示：把 `config.yaml` 的 `models.default` 临时改回 `mock` 再重启（内置 Mock 保留用于测试/演示）。
- 换真实模型：在 `config.yaml` 配置 `models.providers`（openai-compatible/Ollama），把角色实例的 `model` 指到 provider id；Key 经环境变量注入。
- 默认绑定 127.0.0.1；被占用可改 `config.yaml server.port`，或用环境变量 `PORT` 覆盖。

## 已实现能力（对应 v0.2 需求基线）

| 模块                     | 落地内容                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 角色库与组队             | 8 内置模板(YAML) + 自定义模板 CRUD(内置只读) + 项目内实例化(模板快照/停用保留数据)                                                                                                                                                                        |
| 会话与聊天               | user 会话骨架；消息/回合事件(seq/turn/turn_start/end)落盘；Mock/OpenAI/Ollama 网关；**WS 流式 chunk+commit、先盘后推**；重启恢复                                                                                                                          |
| think 展示(2026-09-09)   | 模型 reasoning 增量经 `thought.chunk` 实时上屏（🧠 思考块**默认折叠**、点击展开，独立于回复气泡），流结束以 `thought` 事件落盘、重进可见；`plan/tool_call` 以"计划/将执行"行展示，告知用户 Agent 接下来要做什么                                           |
| 回复渲染(2026-09-09)     | 助手回复按 Markdown 渲染（自研无依赖渲染器 `web/markdown.js`：标题/列表/代码块/行内代码/粗斜体/链接/引用/表格/hr）；先转义后渲染、链接仅放行 http(s)/mailto；用户消息与思考块保持纯文本                                                                   |
| Agent 运行时             | 单工占用 occupancy(runtime.state 落盘)；loop 按实例策略提示(direct/reflective/plan-execute)；**工具循环**：模型 function-calling → 角色白名单工具执行 → 结果回注，至多 6 步                                                                               |
| 工具与审批               | PolicyEngine 命令判定 + 虚拟路径 L0 边界 + 工具执行器(fs/ws/cmd_run/workdir_edit/记忆检索) + 高危命令审批桥(approvals.jsonl，批准续跑/拒绝不执行)；**工具调用全程落审计事件，一次调用只占一行（进行中→✓/✗），与正文按时间线交错展示（多步回合分段落盘）** |
| 角色提问(2026-09-09)     | `ask_user` 工具：Agent 向用户**确认/单选/多选/文本**提问（`questions.jsonl`）；会话输入框上方出**问题卡片**（radio/checkbox/确认按钮/输入框），「需你处理」可就地回答；同会话仅 1 个待答；用户回答 → 答复写回会话并**自动唤醒 Agent 继续**                |
| 代码受控编辑(2026-09-09) | `workdir_edit` 单文件声明式写/替换 + diff 轨迹；dispatcher 注入**当前任务**为归属锚点（改动按 taskId 聚合），任务 done/terminated 时结算为 code artifact 快照（D14-⑧/D17-①）                                                                              |
| 产出物提交制             | 静态产物(ws→workdir 拷贝+sha256+版本快照 v<n>)；doc 门审批(只读预览)；回退按快照恢复；manifest 审计                                                                                                                                                       |
| 记忆与检索               | L3 记忆(全局/角色, active/superseded)；滚动摘要(summary 事件+summaryRefs)；中文 2-gram 倒排索引(可再生)+跨会话/记忆搜索                                                                                                                                   |
| 会议                     | queued/proposed/open/blocked_waiting_user/closed 状态机；成员接受转 open；**用户决策点阻塞→拍板继续**；结束纪要回写参与者与全局记忆；**发起需填主题与描述**，会议窗口顶部显示主题/描述/主持人/参会人及各自回应状态                                        |
| 工作台                   | 无构建静态 SPA(web/)：项目向导(角色可全选)、**左栏「团队=一对一会话 / 会议=全部会议」分区**、发起会议弹窗(主题+描述+参会人)、角色停用/启用、聊天(WS 流式 + Markdown 回复 + 折叠思考块)、审批、产出物回退、记忆/纪要；项目导出 zip                         |
| 存储                     | 纯文件系统(JSON/JSONL/YAML)；无数据库；数据目录不入库，拷贝即迁移                                                                                                                                                                                         |

## 已知边界 / 待办（诚实清单）

- **前端选型**：架构文档原定 React+Vite+AntD；本开发环境沙箱禁止 vite/esbuild 子进程，无法构建验证，前端暂为**无构建原生 ESM 静态页**（接口契约不变，可按 frontend/style.md 在非受限环境迁移 React 版）。
- **代码受控编辑通道(code)**：`workdir_edit` + 任务级聚合(D14-⑧) 已落地（归属注入、结算为 code artifact 快照）；模型可自主调用；未做的是"改动回滚到某个任务版本"的 UI 入口（artifact 回退接口已具备，可在右栏通过产出物回退使用）。
- **任务系统**：乙模式任务 CRUD 与激活规则(D16-④/D17-①) 已落地（用户 UI 指派 → 开工/完成/终止）；**甲模式已开启**（config.yaml `task.assignByAgent: true`）：产品/项目经理（product/pm）在其 user 会话中可直接派单——**推荐调用 `task_assign` 工具**（结构化参数；也兼容回复里的 JSON 数组，解析失败会明确回执、绝不静默）。平台自动登记任务并在受派者空闲时**立即开工**（受派者忙则排队 todo，可在右栏手动开工，同一角色同时只有 1 个 in_progress）；受派者收到「请开始执行任务」系统消息自动回合，并在系统提示中获得当前任务上下文。
- **会议轮次引擎**：主持人逐成员点名发言、成员自主入会剧本、插话仲裁、`meeting_advance` 工具未实现；会议当前以用户驱动走通"发起(主题/描述)→接受→拍板→结束→纪要"。会议描述目前只用于展示，不注入模型上下文；发起后不支持改主题/描述或增删参会人。
- **角色停用**：左栏团队行的「停用/启用」已可用（停用前二次确认、停用后保持当前会话、被停用角色会话只读并禁用输入框）；停用角色不会被拉入新会议。
- **Agent 工具循环**：通用 function-calling 已落地（OpenAI 兼容/Ollama 的 `tools` + `tool_calls`；Mock 不产出工具调用）；`meeting_start/advance/close` 等平台工具尚未注册进注册表，会议仍由用户驱动；审批通过后的"结果回注 Agent 并自动续跑"未实现（批准即执行，Agent 下一条消息可继续）。
- **真实模型验收**：已在用户本机 DEEPSEEK_API_KEY 环境下对默认 deepseek-v4-flash 完成冒烟——正常回复、think/reasoning 展示、PM 派活→开发自动开工、**开发真实多步工具调用**（fs_list_dir → fs_read_file → workdir_edit 写入文件 → 回读复核）。
- 其余按各 `docs/changes/2026-09-08-mN-*.md` 修改记录的"遗留"节为准。

## 文档

- 文档索引与术语表：[docs/README.md](docs/README.md)
- 需求（PRD·决策表·验收脚本）：[docs/requirements/prd.md](docs/requirements/prd.md)
- 分阶段开发方案与验收清单：[docs/plan/development.md](docs/plan/development.md)
- 设计：架构 / 数据存储 / Agent 运行时 / 会话 / 会议 / 记忆 / 工作区产出物 / 工具 / 沙箱（见索引）
- 前端风格 / 接口草案 / 测试计划 / 部署手册 / 修改记录（见索引）

## 路线图

- 文档评审：已完成（v0.2 基线 + D1~D18 决策 + 四轮评审）。
- 编码：M0~M7 交付（工程骨架 → 组队 → 聊天 → 运行时/工具 → 产出物 → 记忆/检索 → 会议 → 工作台）；M8 质量收尾：测试补全、真实模型与 code 通道待非受限环境验证。
- 场景化（远期）：把"角色库+团队编排+产出物类型+流程"打包为任意场景模板。

## 技术栈

Node.js ≥ 20 · TypeScript(strict) · Fastify(HTTP/WS) · 前端无构建 ESM(React+Vite 迁移预留) · 纯文件存储(无 SQLite) · Vitest · 模型网关(Mock/OpenAI 兼容/Ollama)

> 本 README 于 2026-09-08 按 v0.2 需求重写，替代旧 v1 构想（固定 7 角色顺序流水线方案已弃用，见 PRD §7 D9）。
