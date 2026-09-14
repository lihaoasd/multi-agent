# Agent 与场景设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D19-③、prd FR-27/US-16
> 关联：[agent-runtime.md](agent-runtime.md)（运行时/状态机/loop）、[tool-packages.md](tool-packages.md)（工具包挂载）、[orchestration.md](orchestration.md)（项目内编排）、[ui.md](ui.md)（首页 Agent 模块）、[contract.md](../api/contract.md)

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

- 模板文件：内置 `src/shared/roles/<roleId>.yaml`（随仓库、只读、升级可覆盖）；用户自建 `data/roles/<roleId>.yaml`（内置只读、经 UI"基于内置复制新建"）。
- 模板结构在 data-storage §8 的基础上**增加** `scenario` 字段；其余字段（systemPrompt/defaultModel/defaultLoop/tools/artifactTypes/defaultApprovalRules）不变。
- 场景扩展（新增 `general` 模板、场景切换与编排模板）为后续版本 → U10。

## 3. 模板展示字段（首页 Agent 模块，MVP 只读）

| 区块 | 内容 |
| --- | --- |
| 身份 | `roleId`、名称、分类、`scenario`、职责描述 |
| loop | 默认 loop 策略与参数（`direct` / `reflective` / `plan-execute`） |
| 提示词 | 系统提示词**只读预览**（与运行期同源拼装，含平台注入段；不落盘） |
| 工具 | 按**工具包**分组展示（见 tool-packages.md；标注"挂载但运行期不可用"的工具） |
| 模型 | 默认模型（引用 provider id，见 agent-runtime §5） |
| 审批 | 默认审批规则（策略来源之一，见 sandbox.md §5.1） |

契约：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/agent-templates?scenario=` | 模板列表（含上述字段摘要） |
| GET | `/api/agent-templates/:roleId` | 模板详情（提示词预览 + 包展开 + 工具可用性口径） |

## 4. MVP 边界与配置提交（后续）

- **MVP 只展示**：UI 不提供新建/编辑/删除模板与实例配置的提交入口；接口只读。
- 后续"配置提交"（U9）需先定清：
  1. **可配置项**：提示词、loop（策略与参数）、工具（按包挂载/取消）、模型；
  2. **生效范围**：系统模板 vs 项目实例覆盖（实例创建时快照、之后模板变更不回溯，D16-⑤ 已定）；
  3. **校验**：提示词长度/占位符、loop 参数合法性、包不可取消 `required`、模型必须指向已注册 provider；
  4. **留痕**：配置变更需版本化并审计（谁在何时改了什么），运行中的实例变更到可中断点生效。
- 现状只读不代表放弃扩展：模板文件与 `packages`/`tools` 字段已按"可编辑"结构设计，后续只需补提交路径与校验。

## 5. 与其它文档的边界

| 事项 | 归属 |
| --- | --- |
| Agent 状态机（idle/working/waiting）、单工、loop 执行、上下文组装、模型路由 | [agent-runtime.md](agent-runtime.md) |
| 项目内团队组队、实例停止/启用、实例删除 | [agent-runtime.md](agent-runtime.md) §1/§2、prd FR-02 |
| 项目内 Agent 之间的委派关系与画布 | [orchestration.md](orchestration.md) |
| 工具与工具包 | [tools.md](tools.md)、[tool-packages.md](tool-packages.md) |
| 首页与详情页的呈现 | [ui.md](ui.md) |
