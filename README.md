# Agent Haness · 本地多 Agent 软件开发协作平台

一个**本地运行**的 Web 应用：7 个 AI 角色 Agent（产品经理、软件架构师、交互设计师、UI 设计师、开发专家、测试、运维人员）组成虚拟研发团队，围绕一个软件项目从「创意」到「部署」全流程协作；用户作为**决策者/项目经理**参与——提出想法、答复澄清、审批关键节点、随时插话。

## 核心特性

- **7 角色独立会话上下文**：每个角色有自己的会话与工作记忆；角色间通过消息/产出物交流，全部交流对用户可见
- **阶段工作流**：`创意→需求→架构→设计→开发→部署→测试`，产出物经审批自动推进阶段，支持回退
- **澄清与审批**：Agent 遇到模糊处升级用户澄清；关键产出物（PRD/架构/设计/代码/部署/测试）需用户审批
- **本地沙箱**：目标软件在项目 `sandbox/` 目录真实运行与测试（不依赖 Docker）
- **多模型后端**：OpenAI 兼容 API（DeepSeek 等）/ Ollama 本地模型 / Mock 演示，按角色可配置不同模型
- **项目即文件夹**：创建项目生成自包含目录（`project.yaml` + `project.db` + `artifacts/` + `sandbox/` + `logs/`），拷贝/移动即备份/迁移

## 快速开始

环境要求：Node.js ≥ 20（可选：Ollama 或云端 API Key）

```bash
npm install
# 编辑 config.yaml 配置模型（默认 mock 演示，无需 Key 即可体验）
npm run dev        # 开发模式（server:3000 + web:5173）
# 或生产模式：
npm run build && npm run start   # http://127.0.0.1:3000
```

浏览器打开 **http://127.0.0.1:3000**：

1. 新建项目（名称 + 创意描述）
2. 与产品经理对话 → 澄清后自动产出需求文档/PRD
3. 右栏「产出物」审批 → 阶段自动推进
4. 请架构师出方案 → 产出架构文档 → 审批
5. 澄清到达时在右栏直接回答

### 接入真实模型

编辑 `config.yaml`（`models.providers` 已含示例注释）：

```yaml
models:
  default: deepseek-chat      # 改为你配置的 provider id
  providers:
    - id: deepseek-chat
      provider: openai-compatible
      base_url: https://api.deepseek.com/v1
      api_key: ${DEEPSEEK_API_KEY}   # 支持环境变量
      model: deepseek-chat
```

重启服务生效。不同角色可覆盖模型：`agents: { architect: { model: ollama-qwen } }`。

## 项目结构

```
agent_haness/
├── config.yaml          # 软件级配置（端口/模型/项目根目录/审批策略）
├── src/
│   ├── server/          # Web 层：Fastify 路由、WS 网关、静态托管
│   ├── application/     # 应用服务：project/chat/artifact/workflow/orchestrator/澄清/任务/记忆
│   ├── domain/          # 领域层：状态机、消息总线、角色定义（纯函数/可单测）
│   ├── infra/           # 基础设施：SQLite、LLM Provider、工具执行、沙箱、日志
│   └── shared/          # 常量、配置、错误码
├── web/                 # 前端（React + Vite + Ant Design 三栏工作台）
├── docs/                # 全部设计文档（入口 docs/README.md）
└── data/                # 运行时数据（projects/ 项目文件夹 + settings.db，不入库）
```

## 文档

- [文档索引](docs/README.md)：需求/PRD、架构、数据模型、协作机制、Agent 运行时、提示词设计、接口、前端风格、实施计划、测试计划、部署手册
- [修改记录](docs/changes/)：每次变更的完整记录

## 测试

```bash
npm run test        # 全量测试（vitest：单元 + 集成，Mock 模型可重复）
```

## 里程碑进度

| 里程碑 | 状态 |
| --- | --- |
| M0 工程骨架 | ✅ |
| M1 数据层与消息总线 | ✅ |
| M2 单 Agent 对话闭环 | ✅ |
| M3 状态机与产出物 | ✅ |
| M4 全角色 + 运行时机制 | ✅ |
| M5 前端工作台 | ✅ |
| M6 测试/文档/打包 | ✅ |
