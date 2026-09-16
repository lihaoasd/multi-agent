# Agent 与场景设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D19-③（**由 D20 修订**）、D20-⑦⑧、D22（S11：模板删除/停用与批量配置模型）、prd FR-27/FR-35/US-16/US-23
> 关联：[agent-runtime.md](agent-runtime.md)（运行时/状态机/loop）、[model-config.md](model-config.md)（模型条目与配置提交校验/生效/留痕的真源）、[tool-packages.md](tool-packages.md)（工具包挂载）、[orchestration.md](orchestration.md)（项目内编排）、[ui.md](ui.md)（首页 Agent 模块）、[contract.md](../api/contract.md)

## 1. 三层模型（沿用 agent-runtime §1）

```
角色模板 Role Template（系统库，可增删，带场景标签）   ← 抽象层：本文件定义
   └─ 项目实例 Role Instance / Agent（团队组队）        ← 组队层：agent-runtime §1
        └─ 运行时执行：loop + 模型路由 + 工具包          ← 执行层：agent-runtime §3~§6
```

本文件负责**模板层与其展示/配置边界**；运行时行为不在本文件重复。

## 2. 场景标签（scenario）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `scenario` | `software` | **现成**：内置 8 个软件团队模板（pm/product/architect/ux/ui/dev/qa/ops） |
| | `general` | **预留**：通用领域模板；MVP 不放内置模板，只保留字段与筛选能力 |

- 模板文件：内置 `src/shared/roles/<roleId>.yaml`（随仓库、只读、升级可覆盖）；用户自建 `data/roles/<roleId>.yaml`（内置的身份字段只读、经 UI"基于内置复制新建"；其**默认模型与停用**经数据目录覆盖，S11，见 §4）。
- 模板结构在 data-storage §8 的基础上**增加** `scenario` 字段；其余字段（systemPrompt/defaultModel/defaultLoop/tools/artifactTypes/defaultApprovalRules）不变。
- 场景扩展（新增 `general` 模板、场景切换与编排模板）为后续版本 → U10。

## 3. 模板展示与配置字段（首页 Agent 模块）

| 区块 | 内容 |
| --- | --- |
| 身份 | `roleId`、名称、分类、`scenario`、职责描述 |
| loop | 默认 loop 策略与参数（`direct` / `reflective` / `plan-execute`）——**可编辑**（FR-35；**内置模板置灰**，S11） |
| 提示词 | 系统提示词：**可编辑**（FR-35；**内置模板置灰**，S11）；编辑态提供与运行期同源拼装的**预览**（含平台注入段，`origin` 见 system-prompt 接口） |
| 工具 | 按**工具包**分组展示（见 tool-packages.md；标注"挂载但运行期不可用"的工具）——**本轮只读**（U9 剩余） |
| 模型 | `defaultModel`：**模型条目 id**（见 model-config.md §2/§4）——**可编辑**（FR-35；**内置模板也可改**，经数据目录覆盖，S11） |
| 启用状态 | 启用/停用开关（**内置模板也可停用/启用**，S11；停用仅影响此后新建实例） |
| 审批 | 默认审批规则（策略来源之一，见 sandbox.md §5.1） |

契约（完整请求/响应见 [contract.md](../api/contract.md) §2）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/agent-templates?scenario=` | 模板列表（含上述字段摘要） |
| GET | `/api/agent-templates/:roleId` | 模板详情（提示词预览 + 包展开 + 工具可用性口径） |
| POST | `/api/agent-templates` | **基于内置复制新建**（B12/D16-⑤；新 `roleId` 落 `data/roles/`） |
| PATCH | `/api/agent-templates/:roleId` | 编辑提示词 / loop / 模型；**内置模板仅 `defaultModel` 可改**（写数据目录覆盖），传 `systemPrompt` / `defaultLoop` → `ERR_FORBIDDEN`（S11） |
| POST | `/api/agent-templates/:roleId/disable\|enable` | 停用 / 启用模板（**内置模板亦可**，S11；不影响既有实例） |
| DELETE | `/api/agent-templates/:roleId?confirm=true` | **删除用户模板**（S11）：内置 → `ERR_FORBIDDEN`；缺 `confirm=true` → `ERR_VALIDATION`；被项目实例引用 → `ERR_CONFLICT` + `detail.referrers` |
| POST | `/api/agent-templates/bulk-model` | **批量设置默认模型**（S11）：`{roleIds, defaultModel}` → `{updated, skipped}`；内置与用户模板都生效 |

## 4. 配置提交（2026-09-15 起开放三项，FR-35；2026-09-16 S11 增补删除/停用/批量）

**可配置字段矩阵（S11 定稿）**

| 项 | 用户模板 | 内置模板 | 落点 |
| --- | --- | --- | --- |
| `systemPrompt` / `defaultLoop` | 可改 | **只读** → `ERR_FORBIDDEN`（提示"基于内置复制新建"） | 用户模板 yaml + `<roleId>.history/<ts>.yaml` 快照 |
| `defaultModel` | 可改 | **可改**（S11 起；此前为 `ERR_FORBIDDEN`） | 用户模板 yaml + 历史快照 / 内置写 `data/agent-templates-state.json` 覆盖 |
| 启用状态（`disable`/`enable`） | 可停用/启用 | **可停用/启用**（S11 起；此前为 `ERR_FORBIDDEN`） | 用户模板 yaml / 内置写状态文件覆盖 |
| `name`/`category`/`scenario`/`description`/`packages`/`tools`/`artifactTypes` | 复制新建时确定，此后只读 | 只读 | — |
| 删除 | **可删**（S11，二次确认 + 引用保护） | **不可删** → `ERR_FORBIDDEN` | 用户模板目录物理删除 |

**可配置项与校验**

| 项 | 字段 | 校验 |
| --- | --- | --- |
| 提示词 | `systemPrompt` | 非空；长度 ≤ `MODELS__MAX_PROMPT_CHARS`（默认 20000）；**不引入占位符语法** |
| agent loop | `defaultLoop:{strategy,params}` | `strategy` 须已在 `LoopRegistry` 注册；`maxIterations` 1..20、`toolBudget` 0..200；`stepModelOverride` 须指向**已启用模型条目** |
| 模型 | `defaultModel` | 须为 `data/model-config.json` 中**已启用**的模型条目 id |

完整校验清单与失败码见 [model-config.md](model-config.md) §8（#13~#15、#17~#18）。

**停用 / 启用语义（S11 起对内置模板开放）**

- 接口：`POST /api/agent-templates/:roleId/disable|enable`（无 body；空 body 视为 `{}`）。
- **用户模板**：改写 `data/roles/<roleId>.yaml` 的 `enabled` 并追加历史快照。
- **内置模板**：写**数据目录的状态覆盖** `${dataDir}/agent-templates-state.json`（`disabledBuiltins[]` 决定 `enabled`），仓库 `src/shared/roles/*.yaml` 保持只读、**不被改写**，因此重启/升级后停用状态仍在（结构、容错读取与残留清理见 data-storage.md §8）。
- 停用只影响"模板是否出现在此后新建实例/组队的可选清单"；**既有实例不受影响**（靠自身快照继续运行，见下方生效范围）。

**删除语义（S11；仅用户模板）**

- 接口：`DELETE /api/agent-templates/:roleId?confirm=true`；成功 `200 {"deleted":"<roleId>"}`。
- **仅用户模板可删**：内置模板 → `403 ERR_FORBIDDEN`（"内置模板只能停用，不能删除"）；缺少 `confirm=true` → `400 ERR_VALIDATION`（"删除模板需要二次确认"）。
- **引用保护**：被**任何项目实例**（`RoleInstance.roleTemplateId`）引用 → `409 ERR_CONFLICT`，`detail.referrers = [{projectId, projectName, instanceId, displayName}]`，需先从这些项目移除成员。
- **删除内容**：物理删除 `<dataDir>/roles/<roleId>.yaml` 与 `<roleId>.history/` 目录，并清理该 `roleId` 在状态文件里的残留覆盖；写审计（`scope:"template"`、`action:"delete"`）。
- 因引用保护，不存在"删了导致项目缺模板"的路径；实例自身的模板快照仍是兜底。

**批量设置默认模型（S11/D22-③）**

`POST /api/agent-templates/bulk-model`，请求 `{"roleIds":["pm","dev-copy"],"defaultModel":"ds-chat"}`（`defaultModel: null` = 清空默认模型）。

- 返回 `{"updated":["pm"],"skipped":[{"roleId":"x","code":"ERR_NOT_FOUND","message":"…"}]}`；**内置与用户模板都会生效**（内置写状态覆盖、用户写 yaml + 历史快照），每个成功项各写一条模板审计，并对每个成功项广播 `agent-config.updated`。
- 校验：`roleIds` 非字符串数组 / 空数组 / 去重后超过 200 项 → `400 ERR_VALIDATION`；`defaultModel` 不是**已启用模型条目 id** 或 `null` → `400 ERR_VALIDATION`。
- 单条失败不影响其余项，失败项进 `skipped`（如模板不存在 → `ERR_NOT_FOUND`）。

**生效范围（沿用 D16-⑤ 快照，D20-⑦）**

1. **系统模板编辑 / 停用 / 删除**：只影响**此后新建的实例**；既有实例保留创建时的快照并继续按快照运行（UI 对失效模板仅标「模板已停用/已移除」）。删除被项目实例引用时会被引用保护拒绝（见上），因此不存在"删了导致项目缺模板"的路径；`roleTemplateId` 仅作溯源。
2. **项目实例覆盖**：`PATCH /api/projects/:pid/team/:iid` 写 `prompt`/`loop`/`model`（省略=保持）；**下一回合开始**生效（`EffectiveAgentConfigResolver.invalidate`），运行中回合到可中断点；`configVersion` +1。
3. **恢复模板默认**：实例提供「恢复为模板快照」操作（清空覆盖字段），同样下一回合生效。

**留痕（细节见 model-config.md §10）**

- 每次模板保存写 `data/roles/<roleId>.history/<ts>.yaml` 快照，并追加 `data/config-audit.jsonl`（`scope:"template"`）；
- 实例覆盖写 `scope:"instance"` 审计（含 `projectId`/`instanceId` 与字段名摘要）；
- 审计**不含提示词全文**（只记长度与首 40 字符摘要）与任何密钥；
- 变更广播 WS `agent-config.updated`。

**S11（2026-09-16）已实现**：用户模板删除（内置只能停用）、内置模板停用/启用与默认模型覆盖、批量设置默认模型。

**仍不做**：工具与工具包挂载编辑、配置回滚 UI（见 U9 剩余 / U15）。

## 5. 与其它文档的边界

| 事项 | 归属 |
| --- | --- |
| Agent 状态机（idle/working/waiting）、单工、loop 执行、上下文组装、模型路由 | [agent-runtime.md](agent-runtime.md) |
| 项目内团队组队、实例停止/启用、实例删除 | [agent-runtime.md](agent-runtime.md) §1/§2、prd FR-02 |
| 项目内 Agent 之间的委派关系与画布 | [orchestration.md](orchestration.md) |
| 工具与工具包 | [tools.md](tools.md)、[tool-packages.md](tool-packages.md) |
| 首页与详情页的呈现 | [ui.md](ui.md) |
