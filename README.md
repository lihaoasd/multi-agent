# 多 Agent 软件开发协作平台

多 Agent 软件开发协作平台。你以项目负责人的身份创建项目、组建 AI 研发团队，并通过一对一沟通、多人会议、任务派发、审批和产出物管理，把软件需求推进为代码、文档和测试结果。

平台不依赖云服务、外部数据库或账号体系。HTTP/WebSocket 服务、Web 工作台、会话记录、角色记忆、任务状态和审计日志都在本地运行与保存，适合个人开发者在本机搭建一个可控的 AI 研发团队。

## 适用场景

- 从空目录开始，让多个 AI 角色协作完成需求分析、方案设计、开发、测试和文档。
- 接入已有代码仓库，让不同角色在受控权限内阅读、修改和提交成果。
- 使用本地大模型或 OpenAI 兼容接口，在离线、内网或低依赖环境中运行 Agent 工作流。
- 保留完整会话、任务、审批和产出物轨迹，便于复盘 AI 团队的协作过程。

## 核心能力

- **本地项目工作台**：每个项目绑定一个独立工作目录，可使用空目录，也可接入已有仓库。
- **可编排 AI 团队**：内置产品、项目经理、架构、交互、UI、开发、测试、运维 8 类角色模板，支持项目内实例化和自定义。
- **独立角色会话**：每个角色拥有独立会话、状态、任务上下文和记忆，支持 WebSocket 流式输出、Markdown 渲染和推理过程折叠。
- **工具调用循环**：支持 OpenAI 兼容接口、Ollama 和 Mock；模型可按角色权限调用文件、命令、提问、任务、会议、记忆和产出物工具。
- **任务栏协作**：支持任务发布、领取、推进、完成、受阻和终止，状态通过 WebSocket 实时同步。
- **多人会议**：Agent 可发起会议，平台自动推进参会、发言、收尾和纪要生成，纪要可回写参与者记忆。
- **用户决策闸门**：Agent 可通过提问工具请求确认、单选、多选或文本输入；高风险命令会进入审批队列。
- **受控文件编辑**：正式代码和文档写入项目工作目录，文件首次写入记录 owner，并保留角色、任务和变更轨迹。
- **本地记忆与检索**：会话全量落盘，支持滚动摘要、全局/角色记忆和中文关键词检索。
- **纯文件存储**：使用 JSON、JSONL 和 YAML 保存运行时数据，无需 SQLite 或其他外部数据库。

## 技术栈

| 层级   | 技术                                       |
| ---- | ---------------------------------------- |
| 服务端  | Node.js >= 20、TypeScript、Fastify         |
| 实时通信 | WebSocket（`@fastify/websocket`）          |
| 前端   | 原生 ESM 静态页面（`web/`，无前端构建步骤）              |
| 模型接入 | Mock、OpenAI Compatible API、Ollama        |
| 数据存储 | 本地文件系统（JSON / JSONL / YAML）              |
| 工程质量 | TypeScript strict、ESLint、Prettier、Vitest |

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

未创建 `.env` 时，平台使用内置默认值：

- 监听地址：`127.0.0.1:3000`
- 数据目录：`data/`
- 默认模型：`mock`
- 会议功能：开启
- Agent 自主派单：关闭
- 高风险命令审批：开启

### 3. 创建项目

1. 打开工作台，选择“新建项目”。
2. 填写项目名称。
3. 选择本地**工作目录**，正式代码和文档会写入该目录。
4. 选择需要的角色，例如产品、项目经理、架构、开发、测试。
5. 创建项目后，从左侧团队列表进入任一角色会话即可开始协作。

> 建议先用测试目录熟悉流程，再将平台接入真实代码仓库。

### 4. 生产模式运行

```bash
npm run build
npm start
```

构建产物输出到 `dist/`。Fastify 会在同一端口同时提供 API、WebSocket 和 `web/` 静态页面。

## 配置真实模型

配置来自仓库根目录的 `.env` 或进程环境变量。配置键使用双下划线表示层级，数组和对象使用 JSON。`.env` 已在 `.gitignore` 中忽略，不要提交 API Key。

### OpenAI 兼容服务（DeepSeek 示例）

在仓库根目录创建 `.env`：

```dotenv
SERVER__HOST=127.0.0.1
SERVER__PORT=3000

MODELS__DEFAULT=deepseek
MODELS__PROVIDERS=[{"id":"deepseek","kind":"openai-compatible","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY","model":"deepseek-chat","maxTokens":8192}]
DEEPSEEK_API_KEY=sk-your-api-key
```

角色实例中的 `model` 字段引用 provider 的 `id`，例如 `deepseek`；实际模型名由 provider 配置中的 `model` 决定。

### Ollama 示例

```dotenv
MODELS__DEFAULT=ollama-local
MODELS__PROVIDERS=[{"id":"ollama-local","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":"qwen2.5-coder:7b","maxTokens":8192}]
```

### Mock 模式

不配置 provider 时默认使用 Mock，也可以显式设置：

```dotenv
MODELS__DEFAULT=mock
```

Mock 主要用于界面和流程验证，不会像真实模型那样稳定、自主地发起工具调用。

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

修改 `.env` 后需要重启服务。若同一变量同时存在于进程环境和 `.env` 中，以进程环境为准。

## npm 脚本

| 命令                   | 说明                              |
| -------------------- | ------------------------------- |
| `npm run dev`        | 使用 `tsx watch` 启动开发服务，代码变更后自动重启 |
| `npm run build`      | 将 TypeScript 编译到 `dist/`        |
| `npm start`          | 运行构建后的服务                        |
| `npm test`           | 运行全量 Vitest 测试                  |
| `npm run test:watch` | 以监听模式运行测试                       |
| `npm run typecheck`  | 执行 TypeScript 类型检查              |
| `npm run lint`       | 执行 ESLint 检查                    |
| `npm run format`     | 使用 Prettier 格式化仓库               |

## 项目结构

```text
agent_haness/
├── src/
│   ├── server/       # HTTP、WebSocket、静态资源和路由
│   ├── application/  # 应用服务、Agent loop、任务、会议、工具协调
│   ├── domain/       # 纯领域规则、状态机和策略判断
│   ├── ports/        # 存储等 IO 契约
│   ├── infra/        # 文件存储、模型网关、命令执行器等实现
│   └── shared/       # 配置、类型、工具函数和内置角色模板
├── web/              # 无构建前端工作台
├── tests/            # Vitest 测试
├── docs/             # 需求、设计、接口、运维和变更记录
└── data/             # 运行时数据，启动后自动生成
```

代码采用单向分层：

```text
server → application → domain → shared
                      ↘ ports ← infra
```

`src/application/composition.ts` 是组合根，负责把文件存储、模型网关、工具执行器等具体实现注入应用服务。

## 协作机制

### 角色状态

平台统一推导角色状态，优先级为：

```text
已停用 > 会议中 > 等待你处理 > 工作中 > 空闲
```

“等待你处理”包括待回答问题和待审批命令。等待期间角色不会继续执行模型回合。

### 工具与审批

工具是 Agent 影响外部环境的受控通道。平台根据角色白名单、会话类型和工具注册表计算可用工具。高风险命令需要用户批准后才会执行；拒绝结果也会回注给模型，并要求其不得绕过审批。

### 任务流转

启用 `TASK__ASSIGN_BY_AGENT=true` 后，产品或项目经理可以发布任务：

```text
待领取 → 进行中 → 已完成
                   ├─ 受阻
                   └─ 已终止
```

每个角色同一时间最多持有一个进行中任务。任务状态变化会通知委派人并刷新任务栏。

### 产出物归属

- 项目工作目录是正式产出物的保存位置。
- 角色通过受控编辑工具写入或修改文本文件。
- 无主文件首次写入时记录 owner，后续默认只有 owner 可修改。
- 其他角色可以读取，但不能直接改写他人拥有的文件。
- 每次写入会记录角色署名、任务归属和变更轨迹。
- `artifact_submit` 用于登记版本快照、manifest 和署名信息。

## 数据与安全

- 会话、任务、审批、记忆、会议纪要和审计事件保存在 `data/projects/<projectId>/`。
- 用户正式代码保存在创建项目时选择的工作目录中，不与平台运行时数据混放。
- 默认只监听 `127.0.0.1`。若改为 `0.0.0.0` 暴露到局域网，需要自行评估安全风险；当前平台不提供登录鉴权。
- API Key 只应放在 `.env` 或系统环境变量中。
- 删除 `data/` 会清空平台会话与记忆，但不会删除项目工作目录中的正式产出。
- 命令执行产生的副作用无法像文本编辑一样静态判定文件归属，执行前应关注审批提示。

## 当前边界

- 前端当前是无构建原生 ESM，而非 React/Vite 工程；接口契约保持稳定，后续可迁移到组件化前端。
- 不同 Agent loop 策略目前主要体现为系统提示词差异，尚未拆分为完全独立的执行编排器。
- 产出物回退后端接口保留，但界面暂未提供完整回退入口。
- 命令执行的副作用不受文件 owner 锁约束。
- 平台面向本地单用户使用，没有内置多用户认证、云端权限隔离或 SaaS 级租户体系。

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

部分历史文档保留了开发阶段的决策和临时方案；当文档与代码不一致时，以 `src/shared/config.ts`、路由实现和测试为准。
