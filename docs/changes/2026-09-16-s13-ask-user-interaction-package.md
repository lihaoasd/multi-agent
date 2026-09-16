# 修改记录 · S13 `ask_user` 独立为 `interaction` 工具包

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s13-ask-user-interaction-package.md](../plan/2026-09-16-s13-ask-user-interaction-package.md)
> 关联设计：[tool-packages.md](../design/tool-packages.md)、[tools.md](../design/tools.md)、[prd](../requirements/prd.md)（FR-26 / D19-② / D23 / §9 验收 1）、[ui.md](../design/ui.md) §2.4

## 1. 需求 / 问题

`ask_user`（Agent 向用户提问并阻塞等待答复）挂在 `task` 包里，但它是**与用户的人工交互通道**，不属于任务域。用户口径：**应该独立出来一个"交互"工具包**。

顺带发现一处**实现与设计不一致**：真源 `docs/design/tool-packages.md` §3 的 `task` 行本来就没有 `ask_user`，代码里 `infra/tools/builtin/question.ts` 却注册为 `package: 'task'`、`packages.ts` 的 `task.tools` 也带着它——本次按真源修正实现。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| infra | `src/infra/tools/packages.ts` | `task` 包去掉 `ask_user`（描述同步）；**新增 `interaction`（交互）包**：`tools: ['ask_user']`、`required: true`、`riskMax: none`、`network: none`；文件头注明归属一致性约束 |
| infra | `src/infra/tools/builtin/question.ts` | 工具注册元数据 `package: 'task'` → `'interaction'` |
| shared | `src/shared/loop.ts` | `BASE_TOOL_PACKAGES` 增 `'interaction'`（模板未声明 `packages` 时的默认值） |
| shared | `src/shared/roles/*.yaml`（8 个内置角色） | `packages` 增 `interaction`（工具白名单本就含 `ask_user`，行为不变） |
| ports | `src/ports/tools.ts` | `ToolPackageInfo` 注释口径 7 → 8，并注明"包不参与运行期授权" |
| tests | `tests/integration/server/tool-packages-api.test.ts`（新增） | 3 例：① 8 个基础包且全 `required`、`interaction` 只含 `ask_user` 且已注册、`task` 不含 `ask_user`；② **声明 ↔ 注册元数据双向一致**（每个声明工具都能按名找到且 `package` 相同；注册表每个工具都被某包声明）；③ 8 个内置模板都挂 `interaction` 且白名单含 `ask_user` |
| tests | `tests/acceptance/prd-section9.test.ts`、`tests/integration/server/approvals-api.test.ts` | 包数量断言 7 → 8（含文案） |
| docs | `tool-packages.md`、`tools.md`、`ui.md`、`abstraction.md`、`architecture.md`、`README.md`、`prd.md` | 真源表新增 `interaction` 行、口径 7 → 8、"数据来源"路径修正为 `src/infra/tools/packages.ts`；prd 增 **D23**、修订 FR-26 与 §9 验收 1、D19-② 加修订注记 |
| docs | `docs/plan|changes/2026-09-16-s13-*.md`、`plan/development.md`、`README.md` | 本阶段方案与记录、阶段索引 |

## 3. 关键决定

1. **包不参与运行期授权，因此拆包无需数据迁移**：`ToolRegistry.schemasFor(names, sessionType)` 只按"角色工具白名单 × 会话类型"过滤，`ToolExecutor` 不校验包；包是声明/展示/未来挂载单位（D19-②）。既有项目实例快照的 `packages` 里没有 `interaction`，但工具白名单快照不变 → 行为与迁移前完全一致。
2. **`interaction` 仍为全员必选**（`required: true`）：8 个内置角色都依赖 `ask_user`，拆包只改"归属展示"，不该改变可用性。
3. **补一致性断言**：本次暴露的风险是"包声明与工具注册的 `package` 可能不一致"，新增**双向**校验用例，今后新增工具若忘了同步声明/注册会直接测试失败。
4. **真源修正而非放宽**：以 `tool-packages.md` 为准改代码，并把 `interaction` 行补进真源表（同时修正该文件里过时的"数据来源 `src/shared/tool-packages/*.yaml`"）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 集成测试 | `tests/integration/server/tool-packages-api.test.ts` 3/3；`approvals-api`、`prd-section9`（验收脚本 1 断言 8 个包）通过 |
| 全量 | `npm run test` **47 files / 314 tests 全绿** |
| typecheck / eslint | `tsc -p tsconfig.json` + `tsc -p web/tsconfig.json` 0 错误；`eslint .` 0 错误 |
| 依赖棘轮 / 触达门禁 | 违规 0 处；`npm run coverage` 通过 |
| 构建 | `npm run build` 通过 |
| 活体 | 运行实例 `GET /api/tool-packages` 返回 8 个包，`interaction` 含 `ask_user`（`registered=true`）；`task` 不再含 `ask_user`；`GET /api/agent-templates` 的 `packages` 含 `interaction` |

## 5. 遗留

- 自定义/第三方工具包（U8）与包的挂载编辑（U9 剩余）不在本轮。
- `interaction` 目前只有 `ask_user`；后续如新增"确认/选择/上传附件"等交互类工具，按同一归属原则放入该包。
