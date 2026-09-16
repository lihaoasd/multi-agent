# 修改记录 · S10 移除 mock 与 Agent 默认不配置模型

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s10-remove-mock.md](../plan/2026-09-16-s10-remove-mock.md) · 总计划：[development.md](../plan/development.md) §3/§6
> 关联设计：[prd](../requirements/prd.md)（FR-10 / §6 易用性 / §7 D20-②、D21 / §9 验收 2、8）、[model-config.md](../design/model-config.md)、[contract.md](../api/contract.md)、[testing/plan.md](../testing/plan.md)、[data-storage.md](../design/data-storage.md)、[ui.md](../design/ui.md)、[deploy.md](../operations/deploy.md)、[README.md](../README.md)

## 1. 需求 / 问题

用户在运行实例上提出的两点口径变更：

1. **Agent 默认未配置模型**——8 个内置角色模板都写着 `defaultModel: mock`，新建项目的 Agent"天生就有一个模型"，用户希望默认是**未配置**，由用户显式选择。
2. **mock 模型删除**——`mock` 是出厂兜底的假模型（无 Key 也能跑通的那个），用户要求**彻底删除**；同时确认"平台全局默认"的兜底要保留，但**兜底只能是真实模型**。

由此产生的连锁问题：mock 是 `testing/plan.md` 规则 31 的**适配器归一化基准实现**，也是 prd §6 易用性目标与 §9 验收脚本 2「无任何 API Key 也可用 Mock 跑通」的支撑；删除后出厂状态不再能离线跑通任何回合，且历史 `data/model-config.json` 里已存在 mock 供应商/模型与指向它的默认路由。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/model.ts` | `ProviderKind` 收敛为四种（去掉 `'mock'`） |
| infra | `src/infra/model/providers/mock.ts` | **删除文件** |
| infra | `src/infra/model/registry.ts`、`presets.ts` | 注册表只注册四种适配器；预置解析的 kind 白名单同步 |
| infra | `src/infra/config/secret-resolver.ts` | 注释去掉 mock（仅 `ollama` 免密钥） |
| shared | `src/shared/model-presets.yaml` | 删除 mock 预置卡片（预置目录 9 家） |
| shared | `src/shared/config.ts` | `DEFAULT_APP_CONFIG.models.defaultModelId`：`'mock'` → `''`（空 = 未指定） |
| shared | `src/shared/roles/*.yaml`（8 个） | `defaultModel: mock` → `defaultModel: null`（Agent 默认未配置模型） |
| application | `src/application/model-config/validate.ts` | `baseUrl` 对所有 kind 必填且 http(s)；凭证豁免只留 `ollama` |
| application | `src/application/model-config/catalog.ts` | 解析时不再对 mock 豁免 `baseUrl` 检查 |
| application | `src/application/model-config/service.ts` | `ensureInitialized` 重写：① **迁移**未知 kind（含其模型、`routing.defaultModelId`、`stepOverrides`）+ 审计；② 空配置仅做遗留 `MODELS__PROVIDERS` 导入；③ **`MODELS__DEFAULT` 生效**（命中已启用条目 → 平台默认，覆盖导入时"第一条即默认"）；④ **删除内置 mock 兜底** |
| server | `src/server/http-routes/health.ts` | `/api/config` 的 `defaultModelId` 空值报 `null` |
| web | `web/src/api/modelConfig.ts`、`web/src/pages/ModelModule.tsx`、`web/src/pages/AgentModule.tsx` | kind 联合与下拉去 mock；默认模型表单项标注"留空 = 未配置" |
| tests | `tests/helpers-in-memory-adapter.ts`（新增） | 规则 31 归一化基准实现下沉到 `tests/`（产品面不再有假模型） |
| tests | `tests/helpers-model.ts`（新增） | `configureTestModel(deps, …)`：测试显式登记供应商/模型/平台默认 |
| tests | `tests/helpers-server.ts` | 测试配置改由 `buildAppConfig(envMap)` 合成（`MODELS__DEFAULT` 等键对测试同样生效），再覆盖数据根 |
| tests | `tests/integration/server/model-config-s10-bootstrap.test.ts`（新增） | 迁移（4 例）：剔除 mock 供应商/模型 + 清路由/步骤覆盖 + 审计；`MODELS__DEFAULT` 生效与"命中不到不静默换"；出厂空配置 |
| tests | `tests/unit/infra/model-adapters.test.ts`、`model-config-store.test.ts`、`secret-resolver.test.ts` | 基准换 in-memory 替身；fixture kind 改 `ollama` |
| tests | `tests/integration/server/{model-config-api,agent-templates-api,projects-api}.test.ts` | 出厂为空、预置 9 家、`kind:'mock'` 被拒、模板默认模型为 `null`、实例生效模型为 `null`、Ollama 连接测试用替身 fetch |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 2 重写为"未配置模型 → `ERR_MODEL` + 引导"；脚本 1/4/7/8 显式配模型；8.1 预置改 9 家、连接测试改 Ollama |
| docs | `prd.md`、`design/{model-config,architecture,abstraction,agent-runtime,data-storage,ui}.md`、`api/contract.md`、`operations/deploy.md`、`testing/plan.md`、`README.md`、`plan/development.md` | 按新口径回写（见 §4） |
| docs | `docs/plan/2026-09-16-s10-remove-mock.md`、`docs/changes/2026-09-16-s10-remove-mock.md` | 本阶段方案与记录 |

## 3. 关键决定

1. **不保留任何"出厂即可跑"的假模型**：删除 mock 后出厂状态无法离线跑通回合，这是本需求的自然结果；prd §6 易用性目标与 §9 验收 2 同步改为"未配置模型必须给出**明确引导**（`ERR_MODEL` + 配置入口），不静默降级"。
2. **`MODELS__DEFAULT` 从"只展示"变为"初始化阶段生效"**：命中**已启用**模型条目时设为 `routing.defaultModelId`，并覆盖导入时"第一条即默认"的临时值；命中不到就保持不设。这样"平台全局默认"这一级兜底只会落到真实模型（本机 `.env` 已设 `deepseek-flash`）。
3. **迁移放在应用层 `ensureInitialized`，判定用注册表**（`kinds.list()`），store 保持哑读取；因此"未来再删任何一个 kind"都会自动复用同一条迁移路径，且写 `config-audit.jsonl`（`action=migrate`，`diff.removedProviders/removedModels`）留痕。
4. **测试替身下沉 `tests/`**：规则 31 的归一化基准实现改为 `tests/helpers-in-memory-adapter.ts`；脚本化网关 `helpers-scripted-gateway.ts` 保留（它本就是纯 `ModelGateway` 替身）。产品面（`src/`）不再出现任何"假模型"。
5. **测试不再依赖任何默认值**：新增 `configureTestModel`，集成/验收一律显式登记模型；测试上下文的平台配置改由 `buildAppConfig(envMap)` 合成，使 `MODELS__DEFAULT` 等边界键在测试中同样真实生效。
6. **历史文档不改写**：`docs/plan|changes/2026-09-15-*` 保留原口径（记录当时的决策），本次变更以 prd D21 + 本记录 + S10 方案承载。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 全量测试 | **45 files / 306 tests 全绿**（S9 为 44/302；新增 S10 启动初始化 4 例） |
| prd §9 验收 | `tests/acceptance/prd-section9.test.ts` **8/8**（脚本 2 按新口径：出厂无供应商/模型 → Agent 生效模型 `null` → 启动回合 `error.errorCode=ERR_MODEL` 且 message 含引导） |
| typecheck | `tsc -p tsconfig.json --noEmit` 与 `tsc -p web/tsconfig.json --noEmit` 均 0 错误 |
| eslint | 0 错误（含六层 `no-restricted-imports` zones） |
| 依赖棘轮 | `node scripts/import-ratchet.mjs`：违规 0 处（基线 0） |
| 触达门禁 | `node tools/coverage-gate.mjs`：**140/140**（mock.ts 删除后由 141 降为 140；白名单 2 个进程入口） |
| 构建 | `npm run build`（typecheck + vite build）通过 |
| 真实数据迁移（活体） | 在运行实例上完成：`data/model-config.json` 现为 providers `deepseek-flash`+`ollama`、models `ds-chat`、`routing.defaultModelId=null`；`data/config-audit.jsonl` 落 `{"target":{"kind":"provider","id":"unsupported-kind"},"action":"migrate","diff":{"removedProviders":["mock"],"removedModels":["mock"]}}` |
| 接口抽查 | `GET /api/model-presets` → 9 家（无 mock）；`GET /api/model-providers` → 无 mock；`POST /api/model-providers {kind:'mock'}` → 400 `ERR_VALIDATION`；`GET /api/agent-templates` → 8 个模板 `defaultModel=null` |

验收暴露并修复的问题：

1. **`MODELS__DEFAULT` 实际不生效**（原实现只在 `routing.defaultModelId === null` 时设置，而导入流程已把"第一条导入模型"写成默认）→ 改为初始化阶段以 `MODELS__DEFAULT` 为准，并补 3 个用例（生效 / 命中不到不静默换 / 出厂为空）。
2. **测试上下文不合成 env 配置**（`helpers-server` 直接用 `DEFAULT_APP_CONFIG`，导致 `MODELS__DEFAULT`、`MODELS__IMPORT_FROM_ENV` 等边界键在测试里永远走不到）→ 改用 `buildAppConfig(envMap)` 再覆盖数据根。

## 5. 遗留（不在本轮）

- 无 Key 首次体验的替代路径只有**本机 Ollama**（需用户已安装并启动服务）；若后续要"零依赖演示"，需另行设计（如显式的"演示替身供应商"开关，届时按需求立项）。
- 历史项目的实例快照若仍写着 `mock`，运行期按 D20-⑥ 报 `ERR_MODEL`（不静默换模型）；用户在项目内重新选择模型即可。当前 `data/projects/` 无有效项目，无需数据修补。
