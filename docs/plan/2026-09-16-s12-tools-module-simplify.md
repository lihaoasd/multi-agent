# S12 方案：工具模块瘦身（工具包详情弹窗 + 去掉 loop 策略列表）

> 日期：2026-09-16　类型：UI 简化（用户直接指令）　真源：`design/ui.md` §2.4、`prd.md` US-15/FR-26
> 关联：`docs/changes/2026-09-16-s12-tools-module-simplify.md`、`docs/plan/development.md`

## 1 需求

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **已注册工具不再单独列表**：工具只在"工具包详情"弹窗里按包查看 | 首页「工具」模块只有工具包表格；每行「详情」打开弹窗，弹窗内列出该包声明的工具（名称/状态/说明/风险/需审批/幂等）；页面不再出现独立工具表格 |
| R2 | **去掉 agent loop 策略列表** | 「工具」模块不再有"agent loop 策略"卡片；loop 策略仍在 Agent 模板与项目实例的「loop 策略」下拉里可选 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/ToolsModule.tsx` | 三块卡片：工具包表格、**agent loop 策略表格**、**已注册工具表格** |
| 前端 API | `web/src/api/platform.ts` | `toolApi.{packages,tools,loops}`；`ToolPackageView.tools` 只有 `{name, registered}`，说明/风险等需与 `ToolView` 按名关联 |
| 后端 | `src/server/http-routes/tools.ts` | `GET /api/tool-packages`、`GET /api/tools`、`GET /api/loops` —— **本轮不改后端**，接口全部保留 |
| 文档 | `docs/design/ui.md` §2.4 | 写的是"展开：包内工具表格"，并隐含 loop 列表 |

## 3 关键决定

1. **只动前端**：`/api/tools`、`/api/loops` 契约与实现保留（`/api/tools` 仍用于详情弹窗的数据关联；`/api/loops` 当前无前端调用但属既有契约，不删以免影响其它消费者与测试）。
2. **详情用 Modal 而非"展开行"**：包内工具较多（`cmd`/`fs` 等），弹窗能完整展示说明/风险/审批列而不挤压表格；`ToolPackageView.tools` 只给 `{name, registered}`，其余字段从 `/api/tools` 建 `Map` 关联（一次 `useMemo`）。
3. **"未实现"仍要可见**：包表格用「N 个 / 未实现 M」标签提示，弹窗里逐行标「已注册｜未实现」，保持 `registered=false`（已声明未注册）这个既有语义（D19-②）。
4. **loop 策略不进本模块**：策略是"角色/实例配置"里选择的运行参数，不属工具展示面；Agent 模板与项目实例两处的下拉不受影响。

## 4 实现步骤

- `web/src/pages/ToolsModule.tsx`：重写为「工具包表格 + 详情 Modal」；删除 loop 卡片与 loop 状态/请求；`tools` 改为详情数据源（`Map` 索引）。
- `docs/design/ui.md` §2.4：按新交互回写（含"不再单列已注册工具 / 不再展示 loop 策略列表"的显式说明与接口保留说明）。
- 阶段索引：`docs/plan/development.md`、`docs/README.md`；`docs/plan|changes/2026-09-16-s12-*.md`；验收套件的阶段清单加 `s12`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 回归 | `npm test` 全绿（本轮无后端改动，防回归）+ `npm run coverage` 触达门禁 |
| 活体 | 隔离实例启动后打开 `/`，确认「工具」模块只有工具包表格、`详情` 弹窗按包列出工具（含「未实现」标记）、页面无 loop 策略列表 |
| 说明 | 本仓库无前端测试设施（Vitest 仅覆盖 node 侧），因此 UI 以构建 + 活体检查为准，与 S7/S4 的 UI 交付口径一致 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 弹窗信息缺列（包声明无说明/风险） | 与 `/api/tools` 关联失败时显示 `—`，不隐藏行（"未实现"本就是正常状态） |
| 用户其实想删掉 loop 概念 | 本轮按"工具模块里的策略列表不需要"理解，仅移除展示；Agent/项目配置里的策略下拉保留。若还要收敛 loop 概念，需另立需求（会动 `shared/loop.ts`、`LoopRegistry` 与 FR-27） |
