# 修改记录 · S12 工具模块瘦身（工具包详情弹窗 + 去掉 loop 策略列表）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s12-tools-module-simplify.md](../plan/2026-09-16-s12-tools-module-simplify.md)
> 关联设计：[ui.md](../design/ui.md) §2.4、[prd](../requirements/prd.md) US-15/FR-26、[tool-packages.md](../design/tool-packages.md)

## 1. 需求 / 问题

首页「工具」模块一屏堆了三块内容：工具包表格、**agent loop 策略**表格、**已注册工具**表格。用户口径：

1. **已注册工具不要单独列表**——工具应当"看工具包详情时弹窗查看对应的工具"；
2. **agent loop 策略列表不需要**。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/ToolsModule.tsx` | 重写：只保留**工具包表格**（包/id/说明/工具数量+未实现数/最高风险/网络/「详情」）；新增**工具包详情 Modal**（Descriptions + 包内工具表格：工具名/状态「已注册｜未实现」/说明/风险/需审批/幂等）；**删除** loop 策略卡片与已注册工具表格；`tools` 改为详情数据源（`useMemo` 建 `Map` 关联） |
| docs | `docs/design/ui.md` §2.4 | 按新交互回写，并显式写明"不再单列已注册工具、不再展示 loop 策略列表；`/api/tools`、`/api/loops` 契约保留（后者当前无前端调用）" |
| docs | `docs/plan/development.md`、`docs/README.md` | 阶段索引增 S12 |
| tests | `tests/acceptance/prd-section9.test.ts` | 文档交付脚本的阶段清单加 `s12`（要求 plan/changes 记录齐备） |

**后端未改**：`GET /api/tool-packages`、`GET /api/tools`、`GET /api/loops` 契约与实现保持原样（`/api/tools` 仍是详情弹窗的数据源之一）。

## 3. 关键决定

1. **详情用 Modal，而非表格内"展开行"**：包内工具较多且要展示说明/风险/审批列，弹窗不会挤压包列表；`ToolPackageView.tools` 只带 `{name, registered}`，其余字段按工具名与 `/api/tools` 关联，缺失时显示 `—`（不隐藏行——「未实现」本就是正常状态，D19-②）。
2. **loop 策略只从本模块移除**：策略是角色/实例的运行参数，仍在 Agent 模板与项目实例的「loop 策略」下拉里选择；`/api/loops` 契约不删。
3. **US-15「能展开看每个包里有哪些工具」仍成立**：由"展开行"变为"详情弹窗"，信息量不减（多了状态/风险/审批/幂等列），因此 prd 无需修订。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `tsc -p tsconfig.json --noEmit` + `tsc -p web/tsconfig.json --noEmit` 均 0 错误 |
| eslint | `npx eslint .` 0 错误 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-DEgC41SZ.js`） |
| 产物冒烟 | 构建产物中不再包含 `agent loop 策略` 文案，包含 `工具包详情`；页面加载 200 |
| 回归 | `npm test` 全绿（后端无改动，防回归）；`npm run coverage` 触达门禁不变 |
| 说明 | 本仓库无前端测试设施（Vitest 仅覆盖 node 侧），UI 以 **构建 + 产物冒烟 + 代码审阅** 为准，与 S4/S7 的 UI 交付口径一致；浏览器点击级验证需用户刷新页面确认 |

## 5. 遗留

- `/api/loops` 目前无前端消费者（策略下拉用的是前端常量表）；若后续要"策略由后端下发"，可把下拉改为读该接口——本轮不动。
- 工具包仍是只读展示（制作/编辑/卸载属 U8）。
