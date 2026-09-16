# 修改记录 · S11 Agent 模板库删除/停用与一键配置模型

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s11-template-delete-bulk-model.md](../plan/2026-09-16-s11-template-delete-bulk-model.md) · 总计划：[development.md](../plan/development.md) §3/§6
> 关联设计：[prd](../requirements/prd.md)（FR-35 / §7 D22 / §9 验收 8）、[agent-templates.md](../design/agent-templates.md)、[model-config.md](../design/model-config.md)、[data-storage.md](../design/data-storage.md)、[ui.md](../design/ui.md)、[contract.md](../api/contract.md)、[testing/plan.md](../testing/plan.md)（规则 32）

## 1. 需求 / 问题

S10 把 8 个内置角色的默认模型置空后，"Agent 未配置模型"成为常态，用户在界面上遇到两个具体诉求：

1. **Agent 模板库可删除**——模板只能"复制新建"，用户模板（如 `pm-custom`）删不掉；内置模板此前连停用都被拒（403）。
2. **一键配置模型**——未配置模型的 Agent 必须逐个进去点，希望能"一键设置默认模型"，并且能**勾选若干项批量改模型配置**。

两处都有语义分歧，已与用户确认：内置**只能停用**（仓库 yaml 只读）、**只有用户模板可删**、**被项目引用则拒绝删除（409 + 点名）**；一键配置做**模板库批量**与**平台全局默认 + 未配置计数**两个入口（项目内实例批量不在本轮）。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/role-templates.ts` | `RoleTemplateStore` 增 `setModelDefault` 与 `delete`；`setEnabled` 语义放宽（内置写数据目录覆盖） |
| infra | `src/infra/file-store/role-template-store.ts` | 新增 `data/agent-templates-state.json`（`{schemaVersion, disabledBuiltins[], roleModelDefaults{}}`）读写与容错；`loadAll()` 合并内置覆盖；`delete` 删 yaml + 历史目录 + 清理残留覆盖；`setModelDefault` 内置写覆盖/用户走 `update` |
| application | `src/application/team/template-references.ts`（新增） | `TemplateReferenceQuery`：`findTemplateReferrers`（删除保护）+ `findUnconfiguredAgents`（未配置计数，口径 = 启用实例且生效模型为空） |
| application | `src/application/team/agent-config-service.ts` | 视图增 `modelEditable`/`deletable`；`remove(roleId, confirm)`（403/400/409 + referrers）；`bulkSetDefaultModel(roleIds, modelId)`（≤200、返回 `{updated, skipped}`、逐项审计）；内置 `update` 只放开 `defaultModel` |
| application | `src/application/team/team-service.ts` | **缺陷修复**：`effectiveModelLabel`/`effectiveModelAvailable` 改按完整回退链解析（此前只看 `实例覆盖 ?? 模板快照`，导致靠全局默认生效的实例被误标"未配置/不可用"） |
| server | `src/server/http-routes/agent-templates.ts` | `DELETE /api/agent-templates/:roleId?confirm=true`、`POST /api/agent-templates/bulk-model` |
| server | `src/server/http-routes/model-config.ts` | `GET /api/model-config/overview` 增 `unconfiguredAgents{total, items}`（可选注入，缺失时返回空集） |
| bootstrap | `src/bootstrap/composition-root.ts`、`src/bootstrap/main.ts`、`src/server/app.ts`、`tests/helpers-server.ts` | 装配 `agentReferences`（项目/团队维度引用查询）并透传到路由 |
| web | `web/src/api/{agentTemplates,modelConfig}.ts` | 新接口与类型（`remove`/`bulkSetModel`/`ModelConfigOverview`/`UnconfiguredAgentRef`） |
| web | `web/src/pages/AgentModule.tsx` | 表格多选 + 「全选未配置」「选择模型 → 一键配置模型」「清空所选默认模型」；默认模型列显示「未配置」；行操作加「删除」（Popconfirm）；内置模板启用列改为开关；抽屉里内置只放开「默认模型」 |
| web | `web/src/pages/ModelModule.tsx` | 默认路由卡片在未配置 > 0 时提示「当前有 n 个 Agent 未配置模型」；模型行加「设为全局默认」；保存路由后刷新计数 |
| tests | `tests/integration/server/s11-template-delete-bulk.test.ts`（新增） | 5 例：内置删除 403 + 停用落覆盖；用户模板删除二次确认 + 引用 409 + 解除后可删（yaml/历史清除）；批量设默认模型（内置覆盖 + 用户 yaml + 跨重启）；批量入参校验；未配置计数与一键全局默认 |
| tests | `tests/integration/server/agent-templates-api.test.ts` | 重写"内置不可停用"用例为"内置可停用 + 状态跨重启保持"；`TemplateBody` 补 `enabled` |
| docs | `prd.md`、`plan/development.md`、`testing/plan.md`、`README.md`、`design/{agent-templates,data-storage,ui,model-config}.md`、`api/contract.md` | FR-35 与 §9 验收 8 修订、新增 D22 与规则 32、阶段编号与阶段表增 S11、状态文件与接口契约回写 |

## 3. 关键决定

1. **内置模板的"停用/默认模型"落数据目录覆盖，不改仓库 yaml**：内置模板随仓库发行、升级会覆盖，物理改写既不安全也会被冲掉；因此新增 `data/agent-templates-state.json` 只承载这两项，其余字段（名称/提示词/loop/工具/产出类型）对内置仍只读（沿用 D16-⑤"复制新建"口径）。
2. **删除只对用户模板开放，且先做引用检查**：内置删除 → `ERR_FORBIDDEN`（提示只能停用）；被任何项目实例引用 → `409 ERR_CONFLICT` + `detail.referrers`（项目名/实例 id），因此不存在"删了让项目缺模板"的路径（实例快照本就独立）。
3. **"一键配置"分两个入口，都靠既有的回退链生效**：A) 模板库勾选（未配置的默认全选）批量写模板默认模型——影响此后新建实例；B) 模型模块按"未配置 Agent 计数"一键设**平台全局默认**——因 `实例覆盖 → 模板快照 → 平台默认` 含回退，设完现有项目里未配置的实例**立即**可用（这是最快解决 S10 后遗症的路径）。项目内实例批量不在本轮（用户选择）。
4. **批量接口不做"逐个弹窗"**：一次请求内逐项校验/写入，返回 `{updated, skipped:[{roleId, code, message}]}`，成功项各写一条模板审计；`defaultModel: null` 表示清空默认模型。
5. **未配置判定与 dispatcher 同源**：`unconfiguredAgents` 用 `resolveEffectiveAgentConfig`（与回合执行同一函数）计算，避免"界面说未配置、实际能跑"或反之。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 全量测试 | **46 files / 311 tests 全绿**（S10 为 45/306；新增 S11 用例 5 个 + 重写 1 个） |
| 规则 32 覆盖 | `tests/integration/server/s11-template-delete-bulk.test.ts`：内置删除 403、用户删除 `confirm` 校验与 409 + referrers、解除后可删且 yaml/历史清除、批量设默认模型（内置覆盖/用户 yaml/跨重启）、非法入参与非法模型 400、未配置计数 8→0→8 与 `effective.model` 回退生效 |
| typecheck / eslint | `tsc -p tsconfig.json` + `tsc -p web/tsconfig.json` 0 错误；`eslint .` 0 错误 |
| 依赖棘轮 / 触达门禁 | 违规 0 处；**141/141**（新增 `template-references.ts` 已被测试触达） |
| 构建 | `npm run build`（typecheck + vite build）通过 |

验收暴露并修复的缺陷：

1. **`team-service` 的生效模型解析不完整**（只按 `instance.model ?? instance.snapshot.defaultModel` 查模型条目，忽略平台默认）：导致"靠全局默认生效"的实例在界面上显示为 `effectiveModelAvailable=false`（模型不可用），与 S10 引入的兜底链自相矛盾。已改为先算 `resolveEffectiveAgentConfig(...)` 再用 `effective.model` 查条目——这条路径正是"一键设全局默认"后的主路径。

## 5. 遗留（不在本轮）

- **项目内实例的批量配置**（勾选若干实例一键写 `model` 覆盖）本轮未做（用户只选了 A/B 两个入口）；若后续需要，可直接复用 `bulk-model` 的模式加 `PATCH /api/projects/:pid/team/bulk-model`。
- 内置模板的"移除名单 + 恢复入口"未做：当前内置删除被拒、只支持停用/启用切换（停用后仍在库中显示为已停用，可直接启用回来）。
- 删除用户模板不提供"回收站/撤销"（历史快照随目录一并删除）。
