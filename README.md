# Agent Haness

本地运行的多 Agent 软件开发协作平台。用户以“老板/决策者”的身份创建项目、组建 AI 研发团队，并通过一对一会话、多人会议、任务派发、审批和产出物归属机制，把软件需求推进为可运行的代码与文档。

平台不依赖云服务、数据库或账号体系：服务端、前端工作台、会话记录、角色记忆、任务和审计日志都在本机运行与保存。首个内置场景是软件开发，但核心抽象是“角色模板 + 团队编排 + 工具权限 + 协作流程”，后续也可以扩展到其他协作场景。

## 核心特性

- **本地项目工作台**：一个项目绑定一个本地工作目录，可从空目录开始，也可直接接入已有代码仓库。
- **可编排 AI 团队**：内置产品、项目经理、架构、交互、UI、开发、测试、运维 8 类角色模板，支持项目内实例化、停用和自定义角色。
- **一对一 Agent 会话**：每个角色拥有独立会话、状态、任务上下文和记忆，支持 WebSocket 流式输出、Markdown 渲染、推理过程折叠展示与断线恢复。
- **Agent 工具循环**：支持 OpenAI 兼容接口和 Ollama 的 function-calling；模型可按角色白名单调用文件读取、受控编辑、命令执行、提问、派单、会议、产出物登记等工具。
- **发布-领取式任务栏**：产品或项目经理可发布任务，成员领取、推进、完成或标记受阻；任务状态通过 WebSocket 实时同步。
- **用户决策闸门**：Agent 可通过 `ask_user` 发起确认、单选、多选或文本提问；高风险命令进入审批队列，用户批准后才继续执行。
- **受控代码编辑与署名**：项目工作目录是正式产出地，文件首次写入会记录 owner；角色只能修改自己拥有的文件，修改轨迹按任务聚合。
- **记忆与检索**：会话全量落盘，支持滚动摘要、全局/角色记忆以及中文关键词检索。
- **纯文件存储**：使用 JSON、JSONL 和 YAML，无需 SQLite 或外部数据库；复制运行时目录即可迁移会话与记忆。
- **离线 Mock 模式**：未配置模型 Key 时可使用内置 Mock 体验流程；真实工具调用需要 OpenAI 兼容模型或 Ollama。

## 技术栈

| 层         | 技术                                        |
| ---------- | ------------------------------------------- |
| 服务端     | Node.js >= 20、TypeScript、Fastify          |
| 实时通信   | WebSocket（`@fastify/websocket`）           |
| 前端       | 原生 ESM 静态页面（`web/`，无构建步骤）     |
| 模型接入   | Mock、OpenAI Compatible API、Ollama         |
| 数据存储   | 本地文件系统（JSON / JSONL / YAML）         |
| 测试与质量 | Vitest、TypeScript strict、ESLint、Prettier |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服务

```bash
npm run dev
```

打开浏览器访问：

```text
http://127.0.0.1:3000
```

未创建 `.env` 时，服务使用内置默认配置：

- 监听地址：`127.0.0.1:3000`
- 数据目录：`data/`
- 默认模型：`mock`
- 会议功能：开启
- Agent 派单：关闭

### 3. 创建第一个项目

1. 打开工作台，点击“新建项目”。
2. 填写项目名称。
3. 选择一个本地**工作目录**，正式代码和文档会写入该目录。
4. 勾选需要的角色，例如产品、项目经理、架构、开发、测试。
5. 创建项目后，从左侧团队列表进入任一角色会话即可开始协作。

> 建议先使用一个测试目录熟悉流程，再把平台接入真实代码仓库。

### 4. 生产模式运行

```bash
npm run build
npm start
```

构建产物输出到 `dist/`，仍由 Fastify 在同一个端口托管 API、WebSocket 和 `web/` 静态页面。

## 配置真实模型

配置来源是仓库根目录的 `.env` 或进程环境变量。配置键使用双下划线表示层级，数组/对象使用 JSON。`.env` 已被 `.gitignore` 忽略，不要把 API Key 提交到仓库。

### OpenAI 兼容服务示例（DeepSeek）

在仓库根目录创建 `.env`：

```dotenv
SERVER__HOST=127.0.0.1
SERVER__PORT=3000

MODELS__DEFAULT=deepseek
MODELS__PROVIDERS=[{"id":"deepseek","kind":"openai-compatible","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY","model":"deepseek-chat","maxTokens":8192}]
DEEPSEEK_API_KEY=sk-your-api-key
```

角色实例中的 `model` 字段引用的是 provider 的 `id`，例如 `deepseek`；具体模型名由 provider 配置中的 `model` 决定。

### Ollama 示例

```dotenv
MODELS__DEFAULT=ollama-local
MODELS__PROVIDERS=[{"id":"ollama-local","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":"qwen2.5-coder:7b","maxTokens":8192}]
```

### 离线演示

不配置任何 provider 时，默认使用 `mock`。也可以显式设置：

```dotenv
MODELS__DEFAULT=mock
```

Mock 主要用于界面和流程测试，不会像真实模型那样自主产生工具调用。

## 常用配置

```dotenv
# 服务
SERVER__HOST=127.0.0.1
SERVER__PORT=3000
DATA_DIR=data
ROLE_DIRS=["src/shared/roles","data/roles"]

# 审批与沙箱
APPROVAL__HIGH_RISK_COMMANDS=true
APPROVAL__DOC_SUBMIT_APPROVAL=true
APPROVAL__CODE_SUBMIT_APPROVAL=false
SANDBOX__NETWORK=online

# Agent 任务派发
TASK__ASSIGN_BY_AGENT=true

# 会议
MEETING__ENABLED=true
MEETING__AUTO_START=true
MEETING__AUTO_CLOSE=true

# 检索与上下文
SEARCH__ENGINE=keyword
CONTEXT__SESSION__RAW_WINDOW=60
CONTEXT__SESSION__MAX_CHARS_PER_MSG=2000
CONTEXT__GLOBAL__MAX_ENTRIES=12
CONTEXT__ROLE__MAX_ENTRIES=12
CONTEXT__SEARCH__MAX_SNIPPETS=3
CONTEXT__TOOL__RESULT_MAX_CHARS=12000
```

修改 `.env` 后需要重启服务。若同一变量同时存在于进程环境和 `.env`，以进程环境为准。

## 常用脚本

| 命令                 | 说明                                            |
| -------------------- | ----------------------------------------------- |
| `npm run dev`        | 以 `tsx watch` 启动开发服务，代码变更后自动重启 |
| `npm run build`      | 使用 TypeScript 编译到 `dist/`                  |
| `npm start`          | 运行构建后的服务                                |
| `npm test`           | 运行全量 Vitest 测试                            |
| `npm run test:watch` | 测试监听模式                                    |
| `npm run typecheck`  | TypeScript 类型检查                             |
| `npm run lint`       | ESLint 分层依赖与代码规范检查                   |
| `npm run format`     | 使用 Prettier 格式化仓库                        |

## 项目结构

```text
agent_haness/
├── src/
│   ├── server/       # HTTP、WebSocket、静态资源与路由
│   ├── application/  # 应用服务、Agent loop、任务、会议、工具协调
│   ├── domain/       # 纯领域规则与状态机
│   ├── ports/        # 存储等 IO 契约
│   ├── infra/        # 文件存储、模型网关、命令执行器等实现
│   └── shared/       # 配置、类型、通用工具与内置角色模板
├── web/              # 无构建前端工作台
├── tests/            # Vitest 测试
├── docs/             # 需求、设计、运维、测试与变更记录
└── data/             # 运行时数据（自动生成，不入库）
```

代码采用单向分层：

```text
server → application → domain → shared
                      ↘ ports ← infra
```

`src/application/composition.ts` 是组合根，负责把文件存储、模型网关和工具执行器等具体实现注入应用服务。

## 协作模型

### 角色与状态

平台统一推导角色状态，优先级为：

```text
已停用 > 会议中 > 等待你处理 > 工作中 > 空闲
```

“等待你处理”包括待回答问题和待审批命令。等待期间角色不会占用执行槽，也不会提前继续跑模型。

### 工具与审批

工具是 Agent 影响外部环境的唯一受控通道。平台会根据角色白名单、会话类型和工具注册表计算实际可用工具。高风险命令进入审批流程，批准后执行并把结果回注给模型；拒绝也会唤醒模型，并明确要求其不得绕过审批。

### 任务流转

启用 `TASK__ASSIGN_BY_AGENT=true` 后，产品或项目经理可发布任务：

```text
待领取 → 进行中 → 已完成
                   ↘ 受阻
                   ↘ 已终止
```

每个角色同一时间最多持有一个进行中任务。任务完成、受阻或终止时，平台会通知委派人并刷新任务栏。

### 产出物归属

- 项目工作目录是正式产出物的唯一保存位置。
- 角色通过 `workdir_edit` 写入或修改文本文件。
- 无主文件首次写入即认领；后续只有 owner 可修改。
- 其他角色可以读取，但不能直接改写他人拥有的文件。
- 每次写入记录角色署名、任务归属和变更轨迹。
- `artifact_submit` 用于登记版本快照、manifest 和署名信息。

## 数据与安全

- 会话、任务、审批、记忆、会议纪要和审计事件保存在 `data/projects/<projectId>/`。
- 用户正式代码保存在创建项目时选择的工作目录，不与平台运行时数据混放。
- 默认只监听 `127.0.0.1`。若改为 `0.0.0.0` 暴露到局域网，需要自行评估安全风险；当前平台不提供登录鉴权。
- API Key 只应放在 `.env` 或系统环境变量中。
- 删除 `data/` 会清空平台会话与记忆，但不会删除项目工作目录中的正式产出。
- `cmd_run` 产生的命令副作用无法像 `workdir_edit` 一样静态判定文件归属，因此执行命令前应关注审批提示。

## 当前边界

- 前端当前是无构建原生 ESM，而不是 React/Vite 生产工程；接口契约保持稳定，后续可迁移到组件化前端。
- `direct`、`reflective`、`plan-execute` 等 agent loop 策略目前主要体现为系统提示词差异，尚未形成完全独立的执行编排器。
- 产出物回退后端接口保留，但界面暂未提供回退入口。
- 命令执行的副作用不受文件 owner 锁约束。
- 平台面向本地单用户使用，没有内置多用户认证、权限体系或云端隔离。

## 文档

- [文档索引](docs/README.md)
- [产品需求文档](docs/requirements/prd.md)
- [开发计划](docs/plan/development.md)
- [总体架构设计](docs/design/architecture.md)
- [数据存储设计](docs/design/data-storage.md)
- [Agent 运行时设计](docs/design/agent-runtime.md)
- [会话设计](docs/design/sessions.md)
- [会议设计](docs/design/meetings.md)
- [工具设计](docs/design/tools.md)
- [部署与运维手册](docs/operations/deploy.md)
- [变更记录](docs/changes/)

部分历史文档保留了开发阶段的决策、临时方案和日期记录；当文档与当前代码不一致时，以 `src/shared/config.ts`、路由实现和测试为准。
