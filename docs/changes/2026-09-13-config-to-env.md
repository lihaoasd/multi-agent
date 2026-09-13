# 2026-09-13 配置来源统一为 `.env`（删除 config.yaml）

- 需求/问题：用户要求「所有的配置应该都在 .env 里」。
- 类型：重构（配置来源迁移）+ 行为变更（`PORT` 兼容移除）
- 改动范围：`shared/config.ts`、`server/index.ts`、`README.md`、`docs/**`、`config.yaml`(删除)、
  `.env` / `.env.example`、`tests`
- 决策（用户确认）：**彻底改用 .env**（config.yaml 删除，新增入库的 `.env.example` 作模板）；
  **只认新名字**，`PORT` 兼容移除。

## 命名约定

`.env` 是扁平的 key=value，故：**`__`（双下划线）表示层级，数组/对象用 JSON**。

| 配置 | 键 |
| --- | --- |
| 服务 | `SERVER__HOST` / `SERVER__PORT` |
| 数据/角色目录 | `DATA_DIR` / `ROLE_DIRS=["src/shared/roles","data/roles"]` |
| 模型 | `MODELS__DEFAULT` / `MODELS__PROVIDERS=[{...}]`（密钥仍由 provider 的 `apiKeyEnv` 指向，如 `DEEPSEEK_API_KEY`） |
| 审批 | `APPROVAL__HIGH_RISK_COMMANDS` / `APPROVAL__DOC_SUBMIT_APPROVAL` / `APPROVAL__CODE_SUBMIT_APPROVAL` |
| 沙箱/任务/会议/检索 | `SANDBOX__NETWORK` / `TASK__ASSIGN_BY_AGENT` / `MEETING__ENABLED`、`MEETING__AUTO_START`、`MEETING__AUTO_CLOSE` / `SEARCH__ENGINE` |
| 上下文窗口 | `CONTEXT__SESSION__RAW_WINDOW`、`CONTEXT__SESSION__MAX_CHARS_PER_MSG`、`CONTEXT__GLOBAL__MAX_ENTRIES`、`CONTEXT__ROLE__MAX_ENTRIES`、`CONTEXT__SEARCH__MAX_SNIPPETS`、`CONTEXT__TOOL__RESULT_MAX_CHARS` |

未设置的键回退内置默认值；改完**重启服务**生效。

## 实现

1. **`shared/config.ts`**：新增 `configFromEnv(env)`（纯函数，显式传入 env 便于单测）——
   解析上述键为配置形状，再交给原有 `loadConfig(shape, baseDir)` 填默认值 + 解析相对路径。
   容错：非法 JSON/数字/枚举一律**忽略并回退默认**（不因一处笔误让服务起不来）；
   `envBool` 兼容 `true/1/yes/on` 与 `false/0/no/off`。原有 `loadConfig` 契约不变（测试与注入方零改动）。
2. **`server/index.ts`**：启动时 `process.loadEnvFile(<repoRoot>/.env)`（文件不存在则跳过并告警，
   便于"只用真实环境变量"的部署）；删除 `config.yaml` 读取与 `yaml` 解析；`PORT` 兼容移除
   （端口只认 `SERVER__PORT`）。
3. **`.env.example`（新增，入库）**：全部可用键 + 注释 + 示例（含 Ollama / maxTokens 例子）。
   因为 `.env` 被 `.gitignore` 排除，必须有入库模板，否则新环境无从知道有哪些配置项。
4. **`.env`（本地，未入库）**：按新键重写，保留原有取值（端口 3000、deepseek-v4-flash、甲模式开启等）。
5. **`config.yaml` 删除**（`git rm`）。
6. **文档**：README 快速开始、`docs/operations/deploy.md` §3（整节重写为 .env 示例）、
   `docs/design/architecture.md`、`data-storage.md`、`agent-runtime.md`、`sandbox.md`、
   `workspaces-artifacts.md`、`docs/README.md`、`docs/testing/plan.md` 同步；
   历史 `docs/changes/*`（含 config.yaml 字样的当时记录）**保持原样不动**。

## 行为变化

- **配置唯一来源 = `.env`**（或进程环境变量）；`config.yaml` 不再被读取，文件已删除。
- `PORT` 环境变量**不再生效**——用 `SERVER__PORT`。
- `.env` 首次启动若不存在：告警"未找到 .env"，用进程环境变量 + 内置默认值继续（不再报错退出）。

## 验证

- 单测：新增 `tests/config-env-m9c.test.ts`（5 例）——空 env 落默认；逐段解析（含 providers JSON、
  相对路径解析、布尔/数字）；只设部分键时同段其余保持默认；**非法 JSON/数字/枚举回退默认**；布尔写法兼容。
  `tests/config.test.ts` 原有 5 例继续通过（`loadConfig` 契约未变）。
- **真实启动验收**：`node dist/server/index.js`
  ① 默认读取 `.env` → 尝试监听 127.0.0.1:3000（被本机运行中的服务占用 → EADDRINUSE，证明 .env 已加载且端口解析正确）；
  ② `SERVER__PORT=3123` 启动成功，日志 `Agent Haness 已启动: http://127.0.0.1:3123`，启动恢复扫描正常；
  ③ 实测 `GET /api/capabilities` → `{"meeting":true}`、`GET /api/projects` → 1 个项目；随后关闭该进程。
- 全量：`npm run test` → **43 files / 240 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。

## 已知边界

- `.env` 不入库（含密钥），因此**配置项本身的变更不会进 git**；约定：新增/调整配置项时同步更新入库的
  `.env.example`。
- `MODELS__PROVIDERS` 是一行 JSON：可读性不如 YAML 多行，但可用外部环境变量注入（容器/CI 友好）。
- `process.env` 优先于 `.env`（`loadEnvFile` 不覆盖已存在的变量），便于临时覆盖而不改文件。
