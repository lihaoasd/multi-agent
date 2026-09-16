# 修改记录 · S14 删除「默认路由」功能

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s14-remove-model-routing.md](../plan/2026-09-16-s14-remove-model-routing.md)
> 关联设计：[prd](../requirements/prd.md)（D24，修订 D21-②③ / D22-⑤ / FR-34 / US-22 / §9 验收 2、8）、[model-config.md](../design/model-config.md)、[data-storage.md](../design/data-storage.md)、[agent-runtime.md](../design/agent-runtime.md)、[abstraction.md](../design/abstraction.md)、[ui.md](../design/ui.md)、[contract.md](../api/contract.md)、[deploy.md](../operations/deploy.md)、[testing/plan.md](../testing/plan.md)（规则 33）

## 1. 需求 / 问题

用户先问"默认路由是什么作用"，在我说明"全局默认模型 = 生效链第三级兜底；plan/act/critique 步骤覆盖**从未被运行期消费**"后，决定 **删除默认路由功能**，并在追问中明确选择**连机制一起删**（B 方案），即 `routing.defaultModelId` 与 `stepOverrides` 整体退场——这**推翻了 prd D21-② 的"平台默认兜底保留"条款**。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/model-config.ts` | 删 `ModelRouting`、`ModelConfigSnapshot.routing`、`EMPTY_MODEL_CONFIG.routing`；`ConfigLoadNotice` 增 `{ kind: 'routing-removed' }` |
| infra | `src/infra/file-store/model-config-store.ts` | 删 `parseRouting`；新增 `hasLegacyRouting()` 并在加载时丢弃 legacy `routing` + 返回 notice |
| application | `src/application/model-config/{validate,dto,service}.ts` | 删 `validateRouting`/`toRoutingView`/`RoutingView`/`updateRouting`、overview 的 `routing`、删模型时的路由清理、`importLegacy` 的默认模型追踪、`ensureInitialized` 的 `MODELS__DEFAULT` 步骤；新增"legacy `routing` 回写 + `migrate` 审计" |
| application | `src/application/team/{effective-config,team-service,template-references}.ts` | 生效链两级：`resolveEffectiveAgentConfig(instance)` 去掉 fallback 参数；`platformDefaultModel()` 删除；未配置扫描同步 |
| application | `src/application/agent-loop/runner.ts` | `ERR_MODEL` 提示语改为"…并在 Agent 模块或项目内为它选择模型" |
| shared | `src/shared/config.ts` | 删 `ModelsConfig.defaultModelId`、默认值、`MODELS__DEFAULT` 解析 |
| server | `src/server/http-routes/model-config.ts`、`health.ts` | 删 `GET/PUT /api/model-routing`；`/api/config` 的 `models` 去掉 `defaultModelId` |
| bootstrap | `src/bootstrap/composition-root.ts` | 引用查询不再注入 catalog |
| web | `web/src/api/modelConfig.ts`、`web/src/pages/ModelModule.tsx` | 删 `RoutingView`/`getRouting`/`putRouting`/`overview.routing`；删「默认路由」卡片、模型行「设为全局默认」、`routing` 状态；未配置 Alert 改为"去 Agent 模块批量配置 / 项目内覆盖"的指引 |
| tests | `tests/helpers-model.ts`、`unit/{shared/config,application/effective-config,infra/model-config-store}`、`integration/server/{model-config-api,model-config-import,model-config-s10-bootstrap,s11-template-delete-bulk,projects-api}`、`acceptance/prd-section9` | 删 `asPlatformDefault` 与 `updateRouting` 调用、生效链改两级、加 404/无 routing 断言、store 增 legacy notice 用例、S10 bootstrap 文件改为覆盖 S10 旧 kind + S14 routing 两类迁移；新增 `applyModelToAllTemplates()`（验收在建项目前把模型写进模板默认，否则实例快照拿不到模型） |
| docs | 见 §5 | prd（D24 + 连带修订）、design×5、api/contract、operations/deploy、testing/plan（规则 30/32 改写 + 新增规则 33 + §6 记录）、README、development、`.env.example` |

## 3. 关键决定

1. **连机制一起删**：`routing` 不是只在界面上隐藏，而是从数据模型、存储、校验、服务、HTTP 契约、配置项全链路移除。代价是**"一键设全局默认"这条便捷路径退场**（S11-B），未配置 Agent 只能通过"Agent 模块批量配模板默认（影响新建实例）"或"项目内实例覆盖（影响既有实例）"消除——这是本次决策的已知功能损失，已写入 prd D24-④ 与本记录。
2. **`MODELS__DEFAULT` 一并删除**：它的唯一作用就是初始化时播种平台默认模型，机制没了就是死配置。
3. **旧 `routing` 键做真迁移**：存储层丢弃并给 notice，`ensureInitialized` 回写抹掉 + 写 `action=migrate`/`diff.removed=["routing"]` 审计（沿用 S10 的迁移+留痕口径），避免"文件里留着一个永不生效的字段"。
4. **`stepOverrides` 的删除是零风险**：S14 核实它从未被运行期消费（agent loop 用的是 `loop.params.stepModelOverride`），因此没有回合行为变化。
5. **不新增替代性批量接口**：不做"按未配置清单批量写实例模型"（新功能另立需求）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 全量测试 | **47 files / 314 tests 全绿**（`model-config-api` 增 404 与"overview 无 routing"断言；`model-config-s10-bootstrap` 改为 3 例覆盖两类迁移；`model-config-store` 增 legacy routing notice 用例；`effective-config` 改两级；`s11-*` 计数用例改走"模板默认/实例覆盖"；验收脚本 1/4/7 改为"建项目前把模型写进模板默认"） |
| typecheck / eslint | `tsc -p tsconfig.json` + `tsc -p web/tsconfig.json` 0 错误；`eslint .` 0 错误 |
| 依赖棘轮 / 触达门禁 | 违规 0 处；**141/141** |
| 构建 | `npm run build` 通过 |
| 契约抽查 | `GET /api/model-routing` → 404；`GET /api/model-config/overview` 无 `routing` 字段；`GET /api/config` 的 `models` 无 `defaultModelId` |
| 活体（真实数据） | `data/model-config.json` 的 `routing` 键在启动后被抹掉；`data/config-audit.jsonl` 出现 `{"target":{"kind":"routing","id":"removed"},"action":"migrate","diff":{"removed":["routing"]}}` |

## 5. 文档回写清单

- `prd.md`：新增 **D24**；D21-②③、D22-⑤ 加"由 D24 修订/取消"注记；US-22、FR-34 去掉"全局默认模型/loop 步骤默认"；§9 验收 2、8 改写；头部日期行补记。
- `design/model-config.md`、`data-storage.md`、`agent-runtime.md`、`abstraction.md`、`ui.md`：生效链改两级、删「默认路由」相关小节/表项/键表条目、§9.1 改为"未配置统计 + 消除路径"。
- `api/contract.md`：删 `/api/model-routing` 两行、`overview` 去 `routing`、`/api/config` 去 `models.defaultModelId`、补 2026-09-16（S14/D24）修订行。
- `operations/deploy.md`：删 `MODELS__DEFAULT`，检查项改为"在 Agent 模块/项目内为角色选择模型"。
- `testing/plan.md`：规则 30 去掉"回退 defaultModelId"、规则 32 改写为"计数只随模板默认/实例覆盖减少"、**新增规则 33**（默认路由已删除的契约与迁移断言）、§5 映射、§6 验收记录。
- `README.md`（规则数 33、阶段索引 S14、`S0`~`S14`）、`plan/development.md`（S14 行）、`.env.example`（删 `MODELS__DEFAULT` 与相关注释）。

## 6. 遗留

- "未配置 Agent"的**一键批量写实例模型**（项目级批量）仍无入口：本轮按"不新增功能"处理；若需要，按 S11 的 `bulk-model` 模式加 `PATCH /api/projects/:pid/team/bulk-model` 即可。
- 历史 plan/changes 记录（S1/S10/S11 等）中关于"默认路由/MODELS__DEFAULT"的描述保留原样（记录当时的决策），本记录与 prd D24 为准。
