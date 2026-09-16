# 修改记录 · S15 项目详情页瘦身（去「项目信息」卡 + 运行细条归位编排图顶部）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s15-project-detail-slim.md](../plan/2026-09-16-s15-project-detail-slim.md)
> 关联设计：[ui.md](../design/ui.md) §2.1/§3、[prd](../requirements/prd.md) D25（修订 D17-⑥）、FR-01/FR-28/FR-33

## 1. 需求 / 问题

用户直接指令两句：

1. **不需要项目信息展示**；
2. **当前没有 Agent 在工作也不需要**。

追问确认后的口径：①「项目信息」卡整卡删除，但**保留导出 zip**并把按钮上移到详情页顶部标题栏；②运行细条**整条从项目页顶部移除、功能放到编排图顶部**。

现状问题：项目详情页首屏被"创建后基本不变的静态信息"（工作目录/描述/成员 + 一句开发说明）占掉，用户每次进项目都要先划过它；而顶部运行细条在**没有 Agent 工作时**仍常驻一句"当前没有 Agent 在工作"＋空闲/暂停/队列汇总，属纯噪音（它只在"有东西要刹车"时才有用）。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/ProjectModule.tsx` | 详情页标题栏改为"左：返回 / 项目名 / 目录类型；右：`导出项目数据（zip）`（`Tooltip` 承载范围说明）"；**删除「项目信息」`Card`**（`Descriptions` 三项 + 说明文案 + 原导出按钮）与其 `WorkingBar` 渲染；import 侧去掉 `Descriptions`、`WorkingBar`，新增 `Tooltip` |
| web | `web/src/pages/WorkingBar.tsx` | 无 Agent 在工作（`working.length === 0`）时 `return null`，整条不渲染（删掉"当前没有 Agent 在工作"空态与 `Badge` 的 default 分支，忙时仍是 `processing` 圆点）；Card 加 `marginBottom: 12`（自身负责与画布的间距，空闲时不产生空隙）；文件头注释改为"挂在「拓扑」页编排图顶部" |
| web | `web/src/pages/TopologyPanel.tsx` | `import { WorkingBar }`，在画布 `Card` 体内**第一行**渲染 `<WorkingBar projectId={projectId} />`（即"编排图顶部"） |
| docs | `docs/requirements/prd.md` | 新增 **D25**（①去项目信息卡 ②导出上移 ③细条归位＋空闲不渲染 ④能力不减 ⑤D17-④"撤销入口在项目信息页"的落点调整 ⑥仅前端/无迁移）；D17-⑥ 行内标注由 D25-③ 修订；文件头日期行增补 D25 |
| docs | `docs/design/ui.md` | §2.1 增「项目详情」行（标题栏 + 导出 + 无信息卡 + 五个标签页）；§3 增「运行细条（S15 归位）」条目；头部决策依据补 D25 与 FR-33 |
| docs | `docs/README.md` | §1 阶段范围改 `S0`~`S15`；§2 术语「运行细条」改写（编排图顶部、空闲不渲染）；§3.2 决策编号范围改 `D1`~`D25` 并列出 D21~D25；§3.4 标题改 `S0`~`S15` 并增 S15 行 |
| docs | `docs/plan/development.md` | §3 阶段表增 S15 行、关键路径说明改 `S10~S15`；§6 增 S15 结果行 |
| docs | `docs/testing/plan.md` | 规则 20 按 D25-③ 改写（位置 + 空闲不渲染）；§5 映射行补注；§6 增 S15 验收记录 |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 5 的阶段清单加 `s15`（要求 plan/changes 记录齐备） |

**后端未改**：`GET /api/projects/:pid/runtime`、`POST /api/projects/:pid/runtime/stop`、`GET /api/projects/:pid/export` 契约与实现保持原样（细条仍是前两者的前端消费者）。

## 3. 关键决定

1. **信息删、动作留**：「工作目录/描述/成员」是静态信息（项目列表页本就展示名称/描述/工作目录），详情页首屏让给编排与会话；导出是**动作**，故保留并以 `Tooltip` 承载原范围说明，避免为一句说明重新占一行版面。
2. **细条挂「拓扑」页而非全页**：细条＝"看见谁在跑并就地刹车"，与画布节点状态是同一观测面（US-17/FR-28）；「对话」页已有会话内「停止生成」与右栏三列表，不需要重复一条。
3. **空闲不渲染而非"显示空态"**：`working.length === 0` 直接 `return null`，`snapshot.idle/paused/queuedTotal` 汇总也只在忙时出现——细条是"有事才出现"的运行带。
4. **能力不减**：细条移走后，「停止任务」（终止当前任务、未结算改动先结算 code artifact 快照）仍可从右栏任务列表把状态改为 `terminated`（规则 17/26）；`ui.md` §3 已注明该兜底入口。
5. **不新增接口、不动数据**：删除的是展示层；本轮无数据迁移、无契约变更，因此不新增后端测试，只跑回归。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsc -p tsconfig.json` + `tsc -p web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-DT_5cr5L.js`） |
| 产物冒烟 | 产物中 `当前没有 Agent 在工作` = 不出现、`项目信息` = 不出现；`导出项目数据` = 出现、`个 Agent 正在工作` = 出现 |
| 回归 | `npm test` **47 files / 314 tests 全绿**（含脚本 5 的阶段清单 `s15`）；`npm run coverage` 触达 **141/141**；`npm run ratchet` 违规 **0** 处 |
| 活体 | 服务端静态服务的就是 `web/dist`：`GET /assets/index-DT_5cr5L.js` 与产物冒烟结论一致（页面刷新后即生效） |
| 说明 | 本仓库无前端测试设施（Vitest 仅覆盖 node 侧），UI 以 **构建 + 产物冒烟 + 代码审阅** 为准，与 S4/S7/S12 的 UI 交付口径一致；浏览器点击级验证需用户刷新页面确认 |
| flaky 记录 | 首次全量运行出现 **1 例失败**（输出被截断，未记到用例名；本轮无后端改动，判断为既有偶发）；随后**连续 3 次全量重跑均 47 files / 314 tests 全绿**，未复现 |

## 5. 遗留

- 「停止生成/停止任务」的**快捷入口**如今只在「拓扑」页出现；「对话」页仍有会话内「停止生成」，任务级终止在右栏任务列表（这是本轮确认的设计，不是缺陷）。
- 细条的 `error` 提示随空闲态一起隐藏（空闲时无内容可停，服务端异常由拓扑页画布 `Alert` 等其它路径暴露）。
- 若后续要"导出"也一并去掉，只需删标题栏那一个按钮（接口与后端能力独立保留）。
