# S10 方案：移除 mock 模型 + Agent 默认不配置模型

> 日期：2026-09-16　类型：需求变更（用户直接指令）　真源：`prd.md`（本轮修订）、`design/model-config.md`、`api/contract.md`
> 关联：`docs/changes/2026-09-16-s10-remove-mock.md`、`docs/plan/development.md` §S10

## 1 需求

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **彻底移除 mock 模型**：`ProviderKind` 去掉 `mock`、删除 `infra/model/providers/mock.ts`、注册表不再注册、预置目录去掉 mock、校验不再豁免 mock、`/api/model-*` 不再接受 `kind=mock`、前端不再出现 mock 选项 | 全仓 `grep -i mock src/ web/` 只剩注释/测试替身说明；`POST /api/model-providers {kind:'mock'}` → `ERR_VALIDATION` |
| R2 | **Agent 默认不配置模型**：8 个内置角色模板 `defaultModel` 清空 | 新建项目后 `GET /api/projects/:pid/agents` 各实例 `effective.model = null`；`/api/agent-templates` 各模板 `defaultModel = null` |
| R3 | **兜底链保留，但兜底只能是真实模型**：`实例覆盖 → 模板默认(空) → 平台默认 routing.defaultModelId → ERR_MODEL`；出厂**不再自动创建任何供应商/模型**；`MODELS__DEFAULT` 真正生效 | 空 `data/` 冷启动后 `model-config.json` 为 `{providers:[],models:[],routing:{defaultModelId:null}}`；未配置模型时启动回合 → `ERR_MODEL`「该角色还没有可用模型…」 |
| R4 | **旧数据迁移**：加载时剔除 kind 未注册的供应商及其模型、清理指向它们的 routing，并写 `config-audit.jsonl` | 预置含 mock 的旧 `model-config.json` 启动后 mock 供应商/模型消失、`defaultModelId` 置 null、审计留痕 |
| R5 | **文档与验收同步**：prd FR-10 / D20-② / §6 易用性 / §9 脚本 2、8 修订；design / api / testing / README / development 回写 | `docs` 内不再出现"用 Mock 跑通全流程"作为**当前**能力；§9 脚本 2 改为"未配置模型的引导与错误码" |

## 2 影响面（改动前证据）

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 类型 | `src/ports/model.ts:11` | `ProviderKind` 含 `'mock'` |
| 适配器 | `src/infra/model/providers/mock.ts`（全文件） | Mock 适配器实现；`registry.ts:5,28,35` 注册为内置五种之一 |
| 预置 | `src/shared/model-presets.yaml:123-132` | `presetId: mock` 条目 |
| 校验 | `src/application/model-config/validate.ts:26,42,104` | kind=mock 免 baseUrl / 免凭证 |
| 目录 | `src/application/model-config/catalog.ts:77` | kind=mock 免 baseUrl 检查 |
| 启动 | `src/application/model-config/service.ts:653-686` | 空配置自动创建 mock 供应商+模型并设为默认 |
| 环境默认 | `src/shared/config.ts:66`、`docs/operations/deploy.md`、`.env` | `defaultModelId: 'mock'`；`MODELS__DEFAULT` 目前**仅展示不生效**（`health.ts:32`） |
| 角色 | `src/shared/roles/*.yaml`（8 个）`defaultModel: mock` | 新建项目实例快照默认 mock |
| 前端 | `web/src/api/modelConfig.ts:3`、`web/src/pages/ModelModule.tsx:34` | kind 联合与下拉含 mock |
| 测试 | `tests/**`（77 处引用） | 适配器契约基准、集成/验收大量以 mock 为零配置模型 |
| 文档 | prd / design×6 / api / testing / README / deploy / development | 5 种 kind、9 家+mock、无 Key 可跑通等表述 |

## 3 关键决定

1. **不保留任何"出厂即可跑"的假模型**：删除 mock 后出厂状态**无法离线跑通回合**，这是本次需求的自然后果；prd §6「从未配置 Key 的用户用 Mock 即可跑通」与 §9 验收 2 同步改为「未配置模型必须给出明确引导」。用户已确认该口径修订。
2. **`MODELS__DEFAULT` 由"只展示"变为"生效"**：`ensureInitialized` 在导入完成后，若该值命中**已启用**模型条目且 `routing.defaultModelId` 为空，则设为平台默认——这样"全局兜底"落到真实模型（随仓库的 `.env` 已设 `deepseek-flash`），而不是 mock。
3. **迁移放在应用层 `ensureInitialized`**，不放进 store：store 保持"哑读取 + 容错"，策略与审计归应用层；用 `kinds.list()` 判定未知 kind，可复用于未来删除其它 kind。
4. **测试替身下沉到 `tests/`**：规则 31 的「归一化基准实现」改为 `tests/helpers-in-memory-adapter.ts`（不进 `src/`，产品面不再存在 mock 概念）；脚本化网关 `tests/helpers-scripted-gateway.ts` 保留（它本来就是纯 `ModelGateway` 替身，不依赖 mock kind）。
5. **不静默换模型**（D20-⑥）：兜底链全空一律 `ERR_MODEL`，不做任何隐式降级。

## 4 实现步骤

### S10.1 彻底移除 mock（代码）
- `src/ports/model.ts`：`ProviderKind` = `'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'`。
- 删除 `src/infra/model/providers/mock.ts`；`registry.ts` 去 import/注册，注释改「内置四种 kind」。
- `src/infra/model/presets.ts`：`KINDS` 去 `'mock'`（YAML 里若仍有未知 kind 的条目会被 `parsePreset` 丢弃）。
- `src/shared/model-presets.yaml`：删除 mock 预置条目（预置目录变 9 家）。
- `validate.ts`：`validateBaseUrl` 去掉 mock 豁免；`validateCredential` 只保留 `ollama` 免凭证；默认凭证兜底只对 `ollama`。
- `catalog.ts`：删除 `provider.kind !== 'mock' &&`。
- `src/infra/config/secret-resolver.ts`：注释去掉 mock 字样。
- `src/shared/config.ts`：`DEFAULT_APP_CONFIG.models.defaultModelId` 由 `'mock'` 改 `''`（空=未指定）；`health.ts` 的 `/api/config` 报 `defaultModelId || null`。

### S10.2 启动初始化与迁移（`service.ts`）
```
ensureInitialized():
  snapshot ← load()
  # ① 迁移：剔除 kind 不在 kinds.list() 的供应商（含其模型）并清理 routing
  unknown ← providers.filter(p => !kinds.list().includes(p.kind))
  if unknown.length > 0:
      dropProviders(unknown) ; dropModels(其 providerId 落在 unknown) ; routing.defaultModelId ∈ dropped ? null
      commit + audit('migrate', …, { removedProviders, removedModels })
  # ② 空配置且 importFromEnv → importLegacy('env')（不变量：绝不自动造供应商）
  # ③ MODELS__DEFAULT 生效：命中已启用条目 → 设为平台默认（**覆盖**导入时的"第一条即默认"）
  # ④ 不再有 mock 兜底
  return { imported }
```
> 顺序：先迁移再判空，避免"迁移后变空"被当成首次初始化重复导入。

### S10.3 角色默认清空
- `src/shared/roles/{pm,product,architect,ux,ui,dev,qa,ops}.yaml`：删 `defaultModel: mock`（loader 对缺失字段给 `null`，`role-template-store.ts:51`）。

### S10.4 前端
- `web/src/api/modelConfig.ts`：kind 联合去 `mock`。
- `web/src/pages/ModelModule.tsx`：新增供应商下拉去 mock 选项；空态文案改为"先添加供应商与模型条目"。
- `ProjectModule.tsx`：已显示「未配置」（`effectiveModelLabel ?? effective.model ?? '未配置'`），保留；确认 Agent 编辑表单允许留空（未配置）。

### S10.5 测试
- 新增 `tests/helpers-in-memory-adapter.ts`：规则 31 基准（流式增量归一化的参照实现）。
- 新增 `tests/helpers-model.ts`：`configureTestModel(deps, { kind:'ollama', baseUrl, modelId, asPlatformDefault })` —— 显式配置模型（测试不再依赖任何默认值），供集成/验收使用。
- `tests/helpers-server.ts`：测试平台配置改由 `buildAppConfig(envMap)` 合成（使 `MODELS__DEFAULT`/`MODELS__IMPORT_FROM_ENV` 等边界键在测试中真实生效），随后覆盖 `dataDir/roleDirs/configFile` 保证用例隔离。
- 新增 `tests/integration/server/model-config-s10-bootstrap.test.ts`：迁移（剔除未知 kind + 清路由/步骤覆盖 + 审计）、`MODELS__DEFAULT` 生效、"命中不到不静默换"、出厂为空。
- 改写：`unit/infra/model-adapters`（基准换替身）、`unit/infra/model-config-store`、`unit/infra/secret-resolver`（注释）、`unit/application/{loop-strategies,summary-engine}`（模型 id 字符串化）、`integration/server/{model-config-api,agent-templates-api,projects-api}`、`acceptance/prd-section9`（脚本 2 重写、其余显式配模型）。

### S10.6 文档回写
- `prd.md`：FR-10（四种 kind）、D20-②、§6 易用性目标、§9 脚本 2 与脚本 8 表述、第 162 行"Mock 模型全流程可用"。
- `design/model-config.md` §6.1/§6.2/§11；`design/architecture.md`、`abstraction.md`、`agent-runtime.md`、`data-storage.md`、`ui.md`、`sandbox.md`（如涉及）。
- `api/contract.md`：预置目录 9 家、启动初始化条目、kind 枚举。
- `testing/plan.md`：规则 31 改四种 kind、Mock 说明段落改为"测试替身位于 tests/"。
- `README.md` 术语表；`operations/deploy.md`。
- `plan/development.md`：新增 S10 行；`docs/changes/2026-09-16-s10-remove-mock.md` 记录。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `npm test` 全绿；新增迁移/未配置模型/kind 拒绝用例 |
| 六层 | `npm run lint`（含 no-restricted-imports）+ `node tools/import-ratchet.mjs` |
| 触达门禁 | `npm run coverage`（删除 mock.ts 后文件数变化需重新对齐） |
| 构建 | `npm run build`（typecheck + vite） |
| 验收 | `tests/acceptance/prd-section9.test.ts` 按新口径 8/8 |
| 活体 | 真实 `data/` 冷启动：迁移掉 mock 残留 → 新建项目 → Agent 显示未配置 → 启动回合 `ERR_MODEL` → 设平台默认后回合可跑 |

## 6 风险与对策

| 风险 | 对策 |
| --- | --- |
| 验收脚本 2 语义反转（原本"无 Key 可跑"） | 明确改写为"未配置模型的引导与错误码"，并在 changes 记录中标注口径变更 |
| 测试大量依赖 mock 零配置 | 统一经 `configureTestModel` 显式配置，顺带覆盖"未配置"路径 |
| 用户已有 `.env` 指向 mock | `MODELS__DEFAULT` 命中不到已启用条目时保持空，并在 `/api/config` 可见；不静默降级 |
| 旧项目快照仍含 mock 模型 id | 运行期 `catalog.resolve` 报 `ERR_MODEL`（D20-⑥ 不静默换模型）；用户重新选模型即可 |
