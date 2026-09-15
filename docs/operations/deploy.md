# 部署与运维手册 · Agent Haness

> 类别：operations · 状态：草稿(待评审) · 范围：本机本地部署（决策：不云部署、无账号体系）

## 1. 环境要求

- Node.js ≥ 20（本仓库开发/运行唯一运行时）。
- 浏览器：Chrome/Edge 最新（前端构建产物静态托管，无 Node 外的服务依赖）。
- 可选：模型后端（可多家并存，2026-09-15 起在 UI"模型"模块配置，见 [model-config.md](../design/model-config.md)）：
  - OpenAI 兼容 API（DeepSeek / OpenAI / 通义百炼 / Kimi / 智谱 GLM / 火山方舟 / 自定义）：需 API Key；
  - Anthropic Claude / Google Gemini：原生协议，需 API Key；
  - Ollama 本地模型：Ollama 已启动并已 pull 模型；
  - Mock：内置，无需任何 Key，首次体验默认（prd §9 验收 2）。

## 2. 安装与运行

```bash
npm install
npm run dev        # 开发：server :3000 + web :5173（vite 代理 /api、/health、/ws 到 3000）
npm run build      # 服务端类型检查 + 前端构建（产物 web/dist，由服务端单端口托管）
npm start          # 生产：单端口 http://127.0.0.1:3000（tsx 直跑 TS，不产出服务端 dist）
npm run typecheck  # 服务端 + 前端两套 tsconfig 类型检查
npm test           # 全量测试（Vitest：unit + integration）
npm run lint       # ESLint（含六层依赖 zones）
npm run ratchet    # 依赖门禁 ratchet（越层违规只减不增）
npm run reindex    # 检索索引重建（S5 接入前为空操作，命令可用）
```

- **运行方式**：服务端由 `tsx` 直接执行 TypeScript，**没有服务端 `dist`**；`npm run build` 只做类型检查与前端构建。
- **依赖与缓存**：`.npmrc` 把 npm cache 固定到仓库内 `.npm-cache`（已在 `.gitignore`）。若本机 `npm_config_cache` 环境变量指向别处，它会覆盖 `.npmrc`，受限环境请显式指定：`$env:npm_config_cache = "$PWD/.npm-cache"; npm install`。
- 默认绑定 127.0.0.1（`.env` 的 `SERVER__HOST` 可改 0.0.0.0 —— 局域网使用需自行评估安全，无鉴权）。
- 服务重启无损：会话/记忆全落盘（见下）。
- 健康检查：`GET /health`（进程存活、版本、数据目录、联网模式；不含任何密钥）。

## 3. 配置（`.env` + 运行时模型配置）

**平台基础设施配置的唯一来源是 `.env`**（2026-09-13 起 `config.yaml` 已删除）。首次部署：

```bash
cp .env.example .env    # 可选：填 DEEPSEEK_API_KEY（走 env 凭证模式时）
```

**模型供应商 / 模型条目 / 默认路由不在 `.env` 里配**（2026-09-15 起，D20-⑤）：由 UI"模型"模块写入 `data/model-config.json`，**改完即时生效、无需重启**（见 [model-config.md](../design/model-config.md)）。`.env` 只保留引导与边界默认键。

命名约定：**`__`（双下划线）表示层级，数组/对象用 JSON**；未设置的键回退内置默认值。
`.env` 改动需 **重启服务** 生效。常用键：

```dotenv
SERVER__HOST=127.0.0.1
SERVER__PORT=3000
DATA_DIR=data                                  # 运行时数据根（默认仓库内 data/，不入库）
ROLE_DIRS=["src/shared/roles","data/roles"]    # 内置角色模板 + 用户自定义角色

MODELS__CONFIG_FILE=data/model-config.json     # 运行时模型配置文件（UI 维护；不存在时按下方策略初始化）
MODELS__DEFAULT=mock                           # 首次初始化时的默认模型条目 id（mock | 已配置的模型 id）
MODELS__IMPORT_FROM_ENV=true                   # 是否允许从遗留 MODELS__PROVIDERS 一次性导入（此后不再读写）
MODELS__REQUEST_TIMEOUT_MS=60000               # 单次模型请求超时上限
MODELS__MAX_PROMPT_CHARS=20000                 # Agent 提示词长度上限
DEEPSEEK_API_KEY=sk-…                          # 可选：供应商凭证走 { mode:"env", envName:"DEEPSEEK_API_KEY" } 时使用

APPROVAL__HIGH_RISK_COMMANDS=true              # 全局审批策略（项目级可覆盖）
APPROVAL__DOC_SUBMIT_APPROVAL=true             # 保留字段：artifact_submit 免审批直落，当前不读
APPROVAL__CODE_SUBMIT_APPROVAL=false
SANDBOX__NETWORK=online                        # online | offline（sandbox.md §6）
TASK__ASSIGN_BY_AGENT=true                     # 【已废弃 2026-09-14】Agent 委派为默认且受编排图出边约束（D19-④/⑤），该开关不再读取
SEARCH__ENGINE=keyword

CONTEXT__SESSION__RAW_WINDOW=60                # 上下文窗口默认值（agent-runtime §4）
CONTEXT__SESSION__MAX_CHARS_PER_MSG=2000
CONTEXT__GLOBAL__MAX_ENTRIES=12
CONTEXT__ROLE__MAX_ENTRIES=12
CONTEXT__SEARCH__MAX_SNIPPETS=3
CONTEXT__TOOL__RESULT_MAX_CHARS=12000
```

- 完整键列表与注释见仓库根的 **`.env.example`**（入库，可作为模板）。
- 角色/实例的模型解析链（实例 → 模板 → loop 步骤默认 → 平台默认）见 agent-runtime.md §5 与 model-config.md §2。
- **密钥存放**：`env` 模式放 `.env`（已被 `.gitignore` 排除）或真实环境变量；`file` 模式明文存 `data/model-config.json`（`data/` 不入库）。两者都不要写进代码或提交；UI 与接口只显示掩码。
- 部署时若不便使用 `.env` 文件，可直接用进程环境变量（同名即可）；`process.env` 优先于 `.env`。
- 遗留 `MODELS__PROVIDERS`（旧形状）仅在 `data/model-config.json` 不存在且 `MODELS__IMPORT_FROM_ENV=true` 时被一次性导入，之后不再读取（model-config.md §11）。

## 4. 数据位置与备份迁移

| 数据 | 位置 | 备份方式 |
| --- | --- | --- |
| 平台基础设施配置 | `.env`（模板 `.env.example`） | `.env` 不入库（可能含密钥）；改动项请同步到 `.env.example` |
| **平台模型配置**（供应商/模型条目/默认路由） | `data/model-config.json` | 不入库（`file` 模式含密钥明文）；拷贝该文件即可迁移 |
| **配置变更审计** | `data/config-audit.jsonl` | 拷贝（只增日志；不含密钥明文与提示词全文） |
| 运行时项目（会话/记忆/manifest/任务/询问/审批/编排图） | `data/projects/<projectId>/` | **拷贝该文件夹**；UI 提供导出 zip |
| 用户自定义角色 | `data/roles/`（含 `<roleId>.history/` 快照） | 拷贝 |
| 项目产出物 | 用户选定工作目录（不在 data/） | 用户自行纳入自己的版本管理 |

迁移注意事项：换机/换盘后打开项目需**重设 workdir**（project.json 绝对路径会失效）；产出物目录请单独复制。
重置：删除 `data/` 即回到全新状态（不影响工作目录与代码）。

## 5. 维护

- 日志：平台运行日志 `logs/`（不入库）；会话审计在会话 log（导出/检索）。
- 索引重建：`npm run reindex`（损坏/升级后）。
- 升级：拉新代码 → npm install → 重启；schemaVersion 迁移策略见 data-storage.md（向前兼容读取，必要时一次性迁移脚本）。
- 常见问题：模型连接失败（在 UI"模型"模块用 **[测试连接]** 定位 baseUrl/Key/Ollama 是否正常）；端口占用（改 `.env` 的 `SERVER__PORT`）；目录无法写入（权限/边界提示）；删除供应商被拒（被模型条目或 Agent 引用，见引用清单）。
