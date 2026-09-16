# S14 方案：删除「默认路由」功能（含 `defaultModelId` 机制）

> 日期：2026-09-16　类型：需求变更（用户直接指令；**推翻 prd D21-② 的"平台默认兜底"条款**）
> 真源：`docs/design/model-config.md`、`prd.md`（新增 D24）、`api/contract.md`
> 关联：`docs/changes/2026-09-16-s14-remove-model-routing.md`、`docs/plan/development.md`

## 1 需求

用户在问清"默认路由是什么作用"后决定：**删除默认路由功能**——不是只删界面，而是**连机制一起删**（选定 B 方案）。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 删除 `routing`（`defaultModelId` + `stepOverrides`）全链路：端口数据模型、存储读写、校验、DTO、服务、HTTP 接口 | 全仓无 `ModelRouting`/`stepOverrides`/`/api/model-routing`；`GET /api/model-config/overview` 不再有 `routing` 字段 |
| R2 | 生效链收敛为**两级**：`实例覆盖 → 模板快照 → 报错` | 未配模型的 Agent 回合报 `ERR_MODEL`；`/api/projects/:pid/team/:iid` 的 `effective.model` 为 `null`（不受任何"平台默认"影响） |
| R3 | 旧 `data/model-config.json` 里的 `routing` 字段被清理并留痕 | 启动后文件里不再有 `routing`；`config-audit.jsonl` 出现 `action=migrate` + `removed:["routing"]` |
| R4 | 连带清理只服务于 routing 的配置项 `MODELS__DEFAULT` / `config.models.defaultModelId` | `.env.example`、`/api/config`、`Config` 端口与解析中均无该键 |
| R5 | 文档同步：prd（D24 + 修订 D21/§9 验收 8）、design/api/operations/testing/README/development | 活动文档不再把"全局默认模型"当作当前能力；历史 plan/changes 记录不改写 |

## 2 影响面（改动前证据）

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 端口 | `ports/model-config.ts` | `ModelRouting`、`ModelConfigSnapshot.routing`、`EMPTY_MODEL_CONFIG.routing`、`ModelConfigService.updateRouting` |
| 存储 | `infra/file-store/model-config-store.ts` | `parseRouting` + `routing` 读写 |
| 校验/DTO | `application/model-config/{validate,dto}.ts` | `validateRouting`（默认模型必须已启用）、`toRoutingView`、`RoutingView` |
| 服务 | `application/model-config/service.ts` | `updateRouting`；overview 带 routing；删模型时清 `defaultModelId`/`stepOverrides`；`ensureInitialized` 的 `MODELS__DEFAULT` 生效步骤 |
| 生效链 | `application/team/{effective-config,team-service,template-references}.ts` | `resolveEffectiveAgentConfig(instance, { defaultModelId })`（第三级兜底） |
| 配置 | `shared/config.ts`（`models.defaultModelId` + `MODELS__DEFAULT`）、`server/http-routes/health.ts`（`/api/config`） | 键与解析 |
| HTTP | `server/http-routes/model-config.ts` | `GET/PUT /api/model-routing` |
| 前端 | `web/src/api/modelConfig.ts`、`web/src/pages/ModelModule.tsx` | `RoutingView`/`getRouting`/`putRouting`；「默认路由」卡片（全局默认 + plan/act/critique）、模型行「设为全局默认」、未配置 Alert 文案、"一键设全局默认"入口（S11-B） |
| 测试 | `tests/**`（57 处命中） | 路由断言、`MODELS__DEFAULT` 生效、`effective-config` 兜底、`helpers-model.asPlatformDefault`、S11 的"计数归零" |
| 文档 | `design/model-config.md`（§8 #11~#12、§9、§9.1、§11、§13）、`design/{data-storage,agent-runtime,abstraction,ui}.md`、`api/contract.md`、`operations/deploy.md`、`testing/plan.md`（规则 27/29/30/32）、`prd.md`、`README.md`、`.env.example` | 多处把"全局默认/路由"写成当前能力 |

## 3 关键决定

1. **routing 从数据模型删除，旧文件字段启动清理并审计**：`ModelConfigStore.load()` 检测到文件里存在 `routing` 键 → 丢弃该键并返回 `notices: [{ kind: 'routing-removed' }]`；`ensureInitialized` 见到该 notice 立即回写一次（把字段真正从磁盘抹掉）并写 `action=migrate` + `removed:["routing"]` 审计。既有 `stepOverrides` 里指向的模型条目不再有特殊保护（它本就没被消费）。
2. **`MODELS__DEFAULT` / `config.models.defaultModelId` 一并删除**：该键的唯一作用是"初始化时播种平台默认模型"，机制删掉后它是死配置，留着会误导。
3. **未配置 Agent 的修法收敛到"Agent/项目层"**：模型模块保留"未配置模型的 Agent 计数"（提示用），但**去掉"一键设全局默认"**；替代路径：① Agent 模块勾选模板 →「一键配置模型」（影响此后新建实例）；② 项目内对既有实例逐个覆盖模型。**这是本次删除带来的功能损失，在 changes 记录里显式标注。**
4. **生效链只保留两级**：`实例覆盖 → 模板快照`，全空即 `ERR_MODEL`（"该角色还没有可用模型：请在「模型」模块添加供应商与模型条目，并在 Agent/项目内为它选择模型"——**提示语同步修正**，因为不再有"设全局默认"这条路）。
5. **破坏性接口变更可接受**：`/api/model-routing` 删除、`overview` 去掉 `routing`、`/api/config` 去掉 `models.defaultModelId`（本机单用户、无第三方消费者；契约文档同步）。
6. **不新增替代性批量接口**：不做"按未配置清单批量写实例模型"（那是新功能，属另一轮需求）。若用户后续要，再立项。

## 4 实现步骤

1. **端口**：删 `ModelRouting`、`ModelConfigSnapshot.routing`、`EMPTY_MODEL_CONFIG.routing`；`ConfigLoadNotice` 增 `{ kind: 'routing-removed' }`。
2. **存储**：删 `parseRouting`；`parseModelConfigSnapshot` 不产出 `routing` 并检测 legacy 键返回 notice；保存路径不再写 `routing`。
3. **校验/DTO/服务**：删 `validateRouting`、`toRoutingView`、`updateRouting`、overview 的 `routing`、删模型时的 `defaultModelId/stepOverrides` 清理；`ensureInitialized` 删 `MODELS__DEFAULT` 步骤、新增 routing-removed 回写 + 审计。
4. **生效链**：`resolveEffectiveAgentConfig(instance)` 去掉 fallback 参数；`team-service`/`template-references` 同步；`ERR_MODEL` 提示语改为两级口径。
5. **配置与 HTTP**：`shared/config.ts` 删 `models.defaultModelId` 与 `MODELS__DEFAULT` 解析；`/api/config`、`/api/model-routing` 删除。
6. **前端**：`api/modelConfig.ts` 删 `RoutingView`/`getRouting`/`putRouting`、`overview.routing`；`ModelModule` 删「默认路由」卡片、模型行「设为全局默认」、`routing` 状态与 `saveRouting`；未配置 Alert 改成"去 Agent 模块批量配置 / 项目内覆盖"的指引。
7. **测试**：`helpers-model.asPlatformDefault` 删除；`effective-config` 用例改两级；`model-config-store`/`config.test` 删 routing/default 断言、新增 legacy `routing` 清理用例；`model-config-api`/`model-config-import`/`s10-bootstrap`/`s11-*`/验收脚本 2 与 8 按新口径重写。
8. **文档**：prd（新增 D24、修订 D21-②③ 注记、FR/§9 验收 2/8）、design 与 contract/deploy、testing/plan（规则口径 + §6 记录）、README、development、`.env.example`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测/集成 | `npm test` 全绿；新增"legacy routing 清理 + 审计"用例；`effective-config` 两级断言 |
| 契约 | 手测 `GET /api/model-routing` → 404；`overview` 无 `routing` 字段；`/api/config` 无 `models.defaultModelId` |
| 门禁 | `npm run typecheck`（src+web）、`eslint .`、`npm run ratchet`、`npm run coverage`、`npm run build` |
| 活体 | 真实 `data/model-config.json` 启动后 `routing` 键消失且有 migrate 审计；建项目 → Agent `effective.model=null` → 发消息报 `ERR_MODEL`（提示语为两级口径） |

## 6 风险与对策

| 风险 | 对策 |
| --- | --- |
| 删掉全局默认后"未配置 Agent"没有一键修法 | changes 记录显式标注功能损失与替代路径（Agent 模板批量 / 项目内覆盖）；如需"按未配置清单批量写实例模型"另立需求 |
| 旧文件残留 `routing` 造成困惑 | 启动清理 + 审计（R3） |
| `stepOverrides` 的删除保护消失 | 它从未被运行期消费（S14 已核实），删掉不影响任何回合；文档标注为"已删除功能" |
| 破坏性接口变更 | 本机单用户、无外部消费者；契约与 UI 同批更新，前端不再调用 |
