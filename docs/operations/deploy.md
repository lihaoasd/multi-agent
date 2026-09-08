# 部署与运维手册 · Agent Haness

> 类别：operations · 状态：草稿(待评审) · 范围：本机本地部署（决策：不云部署、无账号体系）

## 1. 环境要求

- Node.js ≥ 20（本仓库开发/运行唯一运行时）。
- 浏览器：Chrome/Edge 最新（前端构建产物静态托管，无 Node 外的服务依赖）。
- 可选：模型后端（三选一/混合）：
  - OpenAI 兼容 API（DeepSeek 等）：需 API Key；
  - Ollama 本地模型：Ollama ≥ 某版本并已 pull 模型；
  - Mock：内置，无需任何 Key，首次体验默认。

## 2. 安装与运行

```bash
npm install
npm run dev        # 开发：server:3000 + web:5173（前端代理 /api 与 /ws 到 3000）
npm run build && npm run start   # 生产：单端口 http://127.0.0.1:3000
npm run test       # 全量测试（Vitest）
```

- 默认绑定 127.0.0.1（config.yaml host 可改 0.0.0.0 —— 局域网使用需自行评估安全，无鉴权）。
- 服务重启无损：会话/记忆全落盘（见下）。

## 3. 配置（config.yaml）

```yaml
server: { host: "127.0.0.1", port: 3000 }
dataDir: "data"                 # 运行时数据根（默认仓库内 data/，不入库）
roleDirs: ["src/shared/roles", "data/roles"]   # 内置角色模板 + 用户自定义角色
models:
  default: mock                 # mock | openai-compatible providerId | ollama providerId
  providers:
    - id: deepseek-chat
      kind: openai-compatible
      baseUrl: https://api.deepseek.com/v1
      apiKeyEnv: DEEPSEEK_API_KEY
      model: deepseek-chat
    - id: ollama-qwen
      kind: ollama
      baseUrl: http://127.0.0.1:11434
      model: qwen2.5:14b
    - id: mock
      kind: mock
approval:                       # 全局默认审批策略（项目级可覆盖）；键名与 project.json artifactPolicy 对齐（M9）
  highRiskCommands: true
  docSubmitApproval: true
  codeSubmitApproval: false
sandbox: { network: online }    # online | offline（sandbox.md §6：offline 时一切网络动作 deny）
task: { assignByAgent: false }  # 甲模式开关：true 启用 task_* 工具（D15）
search: { engine: keyword }     # keyword；vector 预留
context:                        # 上下文窗口默认值（agent-runtime §4）
  session: { rawWindow: 60, maxCharsPerMsg: 2000 }
  global: { maxEntries: 12 }
  role: { maxEntries: 12 }
  search: { maxSnippets: 3 }
  tool: { resultMaxChars: 12000 }
```

- 角色/实例模型覆盖：见 agent-runtime.md §5（实例 model → 模板 → models.default）。
- API Key 经环境变量注入（config 支持 `apiKeyEnv`），不入库不进 git。

## 4. 数据位置与备份迁移

| 数据 | 位置 | 备份方式 |
| --- | --- | --- |
| 平台配置 | config.yaml | git 管理（无密钥） |
| 运行时项目（会话/记忆/工作区/manifest/审批） | `data/projects/<projectId>/` | **拷贝该文件夹**；UI 提供导出 zip |
| 用户自定义角色 | `data/roles/` | 拷贝 |
| 项目产出物 | 用户选定工作目录（不在 data/） | 用户自行纳入自己的版本管理 |

迁移注意事项：换机/换盘后打开项目需**重设 workdir**（project.json 绝对路径会失效）；产出物目录请单独复制。
重置：删除 `data/` 即回到全新状态（不影响工作目录与代码）。

## 5. 维护

- 日志：平台运行日志 `logs/`（不入库）；会话审计在会话 log（导出/检索）。
- 索引重建：`npm run reindex`（损坏/升级后）。
- 升级：拉新代码 → npm install → 重启；schemaVersion 迁移策略见 data-storage.md（向前兼容读取，必要时一次性迁移脚本）。
- 常见问题：模型连接失败（检查 baseUrl/Key/Ollama 是否启动）；端口占用（改 config）；目录无法写入（权限/边界提示）。
