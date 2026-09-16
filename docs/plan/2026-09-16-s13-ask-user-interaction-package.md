# S13 方案：`ask_user` 独立为 `interaction`（交互）工具包

> 日期：2026-09-16　类型：需求变更（用户直接指令）　真源：`docs/design/tool-packages.md`、`prd.md` FR-26/D23
> 关联：`docs/changes/2026-09-16-s13-ask-user-interaction-package.md`、`docs/plan/development.md`

## 1 需求

`ask_user`（Agent 向用户提问并阻塞等待答复）**不属于任务域**，不该挂在 `task` 包里；应独立成一个"交互"工具包。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | `ask_user` 从 `task` 包移出，独立为 **`interaction`（交互）** 基础包 | `GET /api/tool-packages` 有 8 个包，`interaction` 只含 `ask_user`（`registered=true`），`task` 不含 `ask_user` |
| R2 | 包集合变化对角色与既有项目**无破坏** | 8 个内置角色模板的 `packages` 含 `interaction` 且工具白名单仍含 `ask_user`；既有项目实例快照无需迁移即可运行（包不参与运行期授权） |
| R3 | 声明与注册元数据一致 | 工具注册的 `package` 字段等于声明它的包；新增双向断言用例 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 包声明 | `src/infra/tools/packages.ts` | 7 个基础包；`task.tools` 含 `ask_user` |
| 工具注册 | `src/infra/tools/builtin/question.ts:54` | `package: 'task'`（与"工具域"语义不符） |
| 基础包常量 | `src/shared/loop.ts` | `BASE_TOOL_PACKAGES` 7 项（模板缺 `packages` 时的默认值） |
| 角色模板 | `src/shared/roles/*.yaml`（8 个） | `packages: [fs, cmd, memory, session, artifact, approval, task]`；`tools` 都含 `ask_user` |
| 文档 | `tool-packages.md`（真源 §2/§3/§5）、`tools.md`、`ui.md`、`abstraction.md`、`architecture.md`、`README.md`、`prd.md` | 多处"7 个基础包"；真源表格里 `task` 行本就没有 `ask_user`（**代码与真源不一致**，本次修正代码） |
| 测试 | `tests/acceptance/prd-section9.test.ts:133`、`tests/integration/server/approvals-api.test.ts:185` | 断言包数量 7 |

**关键判断**：包**不参与运行期授权**——`ToolRegistry.schemasFor(names, sessionType)` 只按"角色工具白名单 × 会话类型"过滤，`ToolExecutor` 也不校验包；包是**声明/展示/未来挂载单位**（D19-②）。因此拆包是元数据变更，既有项目实例快照（`packages` 无 `interaction`）继续可用，**无需数据迁移**。

## 3 关键决定

1. **新包 id 取 `interaction`（显示名"交互"）**：与既有包同风格（英文单数域名词），语义是"与用户的人工交互通道"。
2. **仍为全员必选（`required: true`）**：所有内置角色的工具白名单都含 `ask_user`，拆包不应改变可用性；8 个角色模板同步挂载 `interaction`。
3. **补一致性断言**：本次暴露的正是"声明 vs 注册元数据可能不一致"的风险，因此新增 `tool-packages-api.test.ts` 做**双向**校验（每个声明工具都能在注册表按同名找到，且 `package` 相同；注册表每个工具都被某个包声明）。
4. **真源修正而非放宽**：`tool-packages.md` §3 的 `task` 行原本就没有 `ask_user`，说明这次是**实现与设计不一致**；按真源改代码，并把 `interaction` 行补进真源表。
5. **不新增决策以外的能力**：不做自定义包、不做包的挂载编辑（U8/U9 仍留）。

## 4 实现步骤

- `src/infra/tools/packages.ts`：`task.tools` 去掉 `ask_user`、描述去掉"向用户提问"；新增 `interaction` 包（`tools: ['ask_user']`）。
- `src/infra/tools/builtin/question.ts`：注册元数据 `package: 'task'` → `'interaction'`。
- `src/shared/loop.ts`：`BASE_TOOL_PACKAGES` 增 `'interaction'`。
- `src/shared/roles/*.yaml`（8 个）：`packages` 增 `interaction`。
- `src/ports/tools.ts`：注释口径 7 → 8。
- 测试：`tests/integration/server/tool-packages-api.test.ts`（新增 3 例）+ 既有数量断言 7 → 8（验收脚本 1、approvals-api）。
- 文档：`tool-packages.md`、`tools.md`、`ui.md`、`abstraction.md`、`architecture.md`、`README.md`、`prd.md`（FR-26/D19-②/D23/§9 验收 1）+ 阶段索引与 plan/changes 记录。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 集成 | `npm test` 全绿；新用例断言 8 个包、`interaction=[ask_user]`、`task` 不含 `ask_user`、声明↔注册一致、8 个模板都挂 `interaction` |
| 六层 | `npm run lint` + `npm run ratchet` |
| 触达门禁 | `npm run coverage`（新增测试文件不影响 src 可达性，但需复跑确认） |
| 活体 | 运行实例 `GET /api/tool-packages` 应显示 8 个包且 `interaction` 已注册；`GET /api/agent-templates` 的 `packages` 含 `interaction` |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 既有项目快照里 `task` 仍"含"ask_user 的旧语义 | 包不参与授权，快照 `packages` 只作展示；实例的工具白名单快照不变 → 行为不变 |
| 其它地方硬编码 7 个包 | 已全仓 grep（`7 个基础包`/包数组）并逐一更新；活动文档不留旧口径，历史 plan/changes 记录不改写 |
| 包数量变化影响前端 | 前端只显示 `packages.length`，无硬编码；工具模块详情弹窗（S12）自动按包展示 |
