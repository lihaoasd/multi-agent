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

- 默认绑定 127.0.0.1（`.env` 的 `SERVER__HOST` 可改 0.0.0.0 —— 局域网使用需自行评估安全，无鉴权）。
- 服务重启无损：会话/记忆全落盘（见下）。

## 3. 配置（`.env`）

**配置唯一来源是 `.env`**（2026-09-13 起 `config.yaml` 已删除）。首次部署：

```bash
cp .env.example .env    # 然后把 DEEPSEEK_API_KEY 填上
```

命名约定：**`__`（双下划线）表示层级，数组/对象用 JSON**；未设置的键回退内置默认值。
改完 **重启服务** 生效。常用键：

```dotenv
SERVER__HOST=127.0.0.1
SERVER__PORT=3000
DATA_DIR=data                                  # 运行时数据根（默认仓库内 data/，不入库）
ROLE_DIRS=["src/shared/roles","data/roles"]    # 内置角色模板 + 用户自定义角色

MODELS__DEFAULT=deepseek-v4-flash              # mock | providers 里的 id
MODELS__PROVIDERS=[{"id":"deepseek-v4-flash","kind":"openai-compatible","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY","model":"deepseek-v4-flash"}]
DEEPSEEK_API_KEY=sk-…                          # 密钥；apiKeyEnv 指向这个名字

APPROVAL__HIGH_RISK_COMMANDS=true              # 全局审批策略（项目级可覆盖）
APPROVAL__DOC_SUBMIT_APPROVAL=true             # 保留字段：artifact_submit 免审批直落，当前不读
APPROVAL__CODE_SUBMIT_APPROVAL=false
SANDBOX__NETWORK=online                        # online | offline（sandbox.md §6）
TASK__ASSIGN_BY_AGENT=true                     # 甲模式：产品/项目经理可直接派活
MEETING__ENABLED=true                          # 会议总开关；false 时会议工具/REST/入口全关
MEETING__AUTO_START=true                       # 全员报到后自动开场
MEETING__AUTO_CLOSE=true                       # 讨论链走完自动结束并生成纪要
SEARCH__ENGINE=keyword

CONTEXT__SESSION__RAW_WINDOW=60                # 上下文窗口默认值（agent-runtime §4）
CONTEXT__SESSION__MAX_CHARS_PER_MSG=2000
CONTEXT__GLOBAL__MAX_ENTRIES=12
CONTEXT__ROLE__MAX_ENTRIES=12
CONTEXT__SEARCH__MAX_SNIPPETS=3
CONTEXT__TOOL__RESULT_MAX_CHARS=12000
```

- 完整键列表与注释见仓库根的 **`.env.example`**（入库，可作为模板）。
- 角色/实例模型覆盖：见 agent-runtime.md §5（实例 model → 模板 → `MODELS__DEFAULT`）。
- 密钥只放在 `.env`（已被 `.gitignore` 排除）或真实环境变量里，不要写进代码或提交。
- 部署时若不便使用 `.env` 文件，可直接用进程环境变量（同名即可）；`process.env` 优先于 `.env`。

## 4. 数据位置与备份迁移

| 数据 | 位置 | 备份方式 |
| --- | --- | --- |
| 平台配置 | `.env`（模板 `.env.example`） | `.env` 不入库（含密钥）；改动项请同步到 `.env.example` |
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
