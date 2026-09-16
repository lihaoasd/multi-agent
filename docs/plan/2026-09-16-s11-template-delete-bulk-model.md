# S11 方案：Agent 模板库删除/停用 + 一键配置模型

> 日期：2026-09-16　类型：需求变更（用户直接指令）　真源：`prd.md`（本轮增补 D22）、`design/agent-templates.md`、`api/contract.md`
> 关联：`docs/changes/2026-09-16-s11-template-delete-bulk-model.md`、`docs/plan/development.md` §3/§6

## 1 需求

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **Agent 模板库可删除**：用户模板可物理删除（yaml + 历史目录）；**内置模板只能停用**（仓库 yaml 只读，停用状态持久化在数据目录，重启/升级不复活） | `DELETE /api/agent-templates/<user>` → 200 且文件消失；`DELETE /api/agent-templates/pm` → 403 `ERR_FORBIDDEN`；`POST /api/agent-templates/pm/disable` → 200 且重启后仍为停用 |
| R2 | **被引用则拒绝删除**：模板被任何项目实例引用时删除返回 409 `ERR_CONFLICT` 并点名项目/实例 | 建一个含 `dev-copy` 的项目 → 删 `dev-copy` → 409 且 `detail.referrers` 含该项目与实例 |
| R3 | **一键配置模型 · A（模板库批量）**：Agent 模块勾选模板（未配置的默认全选）→ 选一个模型 → 一键写入它们的默认模型；内置模板的默认模型以数据目录的**运行时覆盖**实现（其余字段仍只读） | `POST /api/agent-templates/bulk-model {roleIds, defaultModel}` → 200 `{updated, skipped}`；内置与用户模板都生效；重启后内置覆盖仍在；非法/停用模型 → 400 |
| R4 | **一键配置模型 · B（平台默认 + 未配置计数）**：模型模块展示"当前 n 个 Agent 未配置模型"，并支持一键把某模型设为平台全局默认（因生效链含回退，设完现有项目里未配置的实例立即可用） | `GET /api/model-config/overview` 返回 `unconfiguredAgents` 明细/计数；设为全局默认后计数归零；未配置实例的生效模型立即非空 |

## 2 现状（改动前证据）

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 模板存储 | `src/infra/file-store/role-template-store.ts` | 只有 `list/get/create/update/setEnabled/appendHistory/listHistory`；**没有 delete**；内置 `update`/`setEnabled` 一律 `ERR_FORBIDDEN`；`data/roles/` 为用户模板目录 |
| 模板服务 | `src/application/team/agent-config-service.ts` | `setEnabled` 直传 store（内置被 store 拒）；视图只有 `editable`（= 用户模板） |
| 模板路由 | `src/server/http-routes/agent-templates.ts` | 无 DELETE、无批量接口 |
| 引用查询 | `src/application/model-config/references.ts` | 只有模型条目的模板引用查询；**无模板 → 项目实例**的引用查询 |
| 未配置计数 | `src/application/model-config/service.ts` | `overview()` 不含 Agent 未配置统计 |
| 前端 | `web/src/pages/AgentModule.tsx`、`ModelModule.tsx` | 列表无多选、无删除、无批量；默认路由卡片只有全局默认下拉，无未配置提示 |

## 3 关键决定

1. **内置模板的"停用"与"默认模型"用数据目录的运行时覆盖**（`data/agent-templates-state.json`），仓库 `src/shared/roles/*.yaml` 不被改写：
   `{ schemaVersion: 1, disabledBuiltins: string[], roleModelDefaults: Record<string, ModelId | null> }`。
   理由：内置模板随仓库发行、升级会覆盖，物理改写既不安全也会被冲掉；而 R1/R3 都需要"内置也能停用/配默认模型"。**其余字段（名称/提示词/loop/工具）对内置仍然只读**（沿用 D16-⑤"复制新建"口径）。
2. **删除只对用户模板开放**（用户已确认）：内置删除 → `ERR_FORBIDDEN` 并提示"只能停用"。
3. **删除前做引用检查**（用户已确认）：扫描项目实例的 `roleTemplateId`，有引用 → `ERR_CONFLICT` + `detail.referrers`（项目名/实例 id）。要求 `?confirm=true` 二次确认（否则 400 提示）。
4. **未配置的判定口径**：项目实例中 `enabled=true` 且**生效模型为空**（`实例覆盖 → 模板默认 → 平台默认` 全空）的数量与明细。计数由新增的 `ModelReferenceQuery.findUnconfiguredAgents()` 提供（装配处用项目/团队存储实现），随 `GET /api/model-config/overview` 返回。
5. **批量写入不逐个弹窗**：一次请求内对每个模板做校验与写入，返回 `{ updated, skipped }`；每个模板仍各写一条配置审计（`scope=template`）。

## 4 实现步骤

### S11.1 端口与存储
- `ports/role-templates.ts`：`RoleTemplateStore` 增 `delete(roleId)`、`setModelDefault(roleId, modelId|null)`；`setEnabled` 语义放宽为"内置写状态覆盖、用户写 yaml"；返回的 `RoleTemplate` 已是**合并后**的有效值。
- `infra/file-store/role-template-store.ts`：
  - 读 `data/agent-templates-state.json`（容错解析、`schemaVersion` 校验、未知 roleId 忽略）；
  - `loadAll()` 合并覆盖：内置的 `enabled`/`defaultModel` 取状态文件优先；
  - `delete()`：仅用户模板，删 `${userDir}/<roleId>.yaml` 与 `${userDir}/<roleId>.history`；
  - `setModelDefault()`：内置 → 写状态文件；用户 → 走 `update`（含历史快照）。

### S11.2 应用服务
- `application/team/agent-config-service.ts`：
  - 视图新增 `deletable`（= 用户模板）、`modelEditable`（= true，内置的默认模型可经覆盖修改）；
  - `remove(roleId, confirm)`：内置 → 403；未确认 → 400；引用检查 → 409 + referrers；成功 → `store.delete` + 审计 `delete`；
  - `bulkSetDefaultModel(roleIds, modelId|null)`：模型启用校验 → 逐个 `setModelDefault` → 返回 `{updated, skipped}`；广播一次 `agent-config.updated`；
  - `setEnabled`：内置不再拦（store 处理）。
- 新增引用查询接口 `TemplateReferenceQuery`（`agent-config-service` 依赖）：`findTemplateReferrers(roleId)` 与 `findUnconfiguredAgents()`。

### S11.3 路由与契约
- `DELETE /api/agent-templates/:roleId?confirm=true`
- `POST /api/agent-templates/bulk-model`（`{ roleIds: string[], defaultModel: string | null }`）
- `GET /api/model-config/overview` 增 `unconfiguredAgents: { total, items: [{projectId, projectName, instanceId, displayName}] }`
- `contract.md` 与 `design/agent-templates.md`、`design/model-config.md`、`design/data-storage.md`（新增状态文件）、`design/ui.md` 同步。

### S11.4 装配
- `bootstrap/composition-root.ts`：用项目存储 + 团队服务实现 `TemplateReferenceQuery`（当前项目实例的 `roleTemplateId` 与生效模型），注入两个服务。

### S11.5 前端
- `AgentModule`：表格 `rowSelection`；工具栏「全选未配置」「一键设默认模型（选模型 + 应用）」；行操作加「删除」（仅 `deletable`，`Popconfirm` + 引用冲突提示）；「停用/启用」对内置开放；抽屉里内置模板只放开"默认模型"。
- `ModelModule`：默认路由卡片显示「当前 n 个 Agent 未配置模型」（0 时隐藏），模型列表行加「设为全局默认」一键按钮。

### S11.6 测试
- `tests/integration/server/agent-templates-api.test.ts`：内置停用持久化（复用 `root` 模拟重启）、内置删除 403、用户模板删除 200 且文件消失、被引用删除 409 + referrers、批量设默认模型（内置 + 用户）、非法模型 400。
- `tests/integration/server/model-config-api.test.ts`（或新文件）：`overview.unconfiguredAgents` 计数随"建项目 → 设模板默认/全局默认"变化。
- 规则：`testing/plan.md` 增规则 32（模板删除/停用与批量模型配置）。

### S11.7 文档
- `prd.md` 增 D22（口径）+ §9 验收 8 补充；`docs/plan/development.md` 增 S11 行；本方案与 `docs/changes/...` 记录。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测/集成 | `npm test` 全绿；上述新增用例覆盖 R1~R4 |
| 六层 | `npm run lint` + `npm run ratchet` |
| 触达门禁 | `npm run coverage`（新增源文件需被测试可达） |
| 构建 | `npm run build` |
| 活体 | 真实实例：停用内置模板并重启 → 仍停用；建项目 → overview 计数 = 实例数 → 一键设全局默认 → 计数归零、实例生效模型非空 |

## 6 风险与对策

| 风险 | 对策 |
| --- | --- |
| 内置覆盖状态与仓库 yaml 双源 | 覆盖只存"停用"与"默认模型"两项；其余字段一律读 yaml；未在覆盖表中的内置模板行为与今天一致 |
| 删除模板后既有项目 | 用户已确认：**被引用即拒绝**，因此不存在"删了导致项目缺模板"的路径（实例快照仍作为兜底） |
| 批量接口被误用（清空模型） | `defaultModel: null` 视为"清空默认模型"，允许但需在返回中体现；非法/停用模型 id → 400 整单拒绝 |
