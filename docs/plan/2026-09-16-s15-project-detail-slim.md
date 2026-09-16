# S15 方案：项目详情页瘦身（去「项目信息」卡 + 运行细条移到编排图顶部）

> 日期：2026-09-16　类型：UI 简化（用户直接指令）　真源：`design/ui.md` §2.1/§3、`prd.md` D17-⑥（由 D25 修订）
> 关联：`docs/changes/2026-09-16-s15-project-detail-slim.md`、`docs/plan/development.md`

## 1 需求

用户口径（两句原文）：

1. **不需要项目信息展示**；
2. **当前没有 Agent 在工作也不需要**。

确认后的实现口径（用户二选一回答）：

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 项目详情页**删掉「项目信息」卡片**：工作目录 / 描述 / 成员三项与"会话已接入（S3…）"说明文案不再展示 | 进入某项目后，标题栏下方**没有**「项目信息」卡片；页面直接是「拓扑 / 团队与配置 / 对话 …」标签页 |
| R2 | **保留**「导出项目数据（zip）」入口，**移到详情页顶部标题栏**（右侧），范围说明改由 `Tooltip` 承载 | 标题栏右侧有「导出项目数据（zip）」按钮，悬停显示"只导出运行时项目文件夹（会话/记忆/产出物/任务），不含工作目录"；点击仍下载 zip |
| R3 | 顶部**运行细条移到「拓扑」标签页内、编排图上方**（不再横跨两个标签页） | 「拓扑」页编排图卡片上方出现运行细条；「团队与配置」「对话」等其它标签页不再出现该细条 |
| R4 | 细条**空闲不渲染**：没有 Agent 在工作时整条不出现（不再显示"当前没有 Agent 在工作"） | 无 Agent 工作时编排图上方为空；有 Agent 工作时正常显示占用者 / 任务 / plan / 队列与「停止生成」「停止任务」 |
| R5 | **后端与既有能力不变**：`GET /api/projects/:pid/runtime`、`POST /api/projects/:pid/runtime/stop`、`GET /api/projects/:pid/export` 契约与实现保持原样 | 接口契约、测试、覆盖率门禁均不变；「停止任务」（终止任务并先结算快照）仍可从右栏任务列表把状态改为 `terminated` 达成 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 · 详情页 | `web/src/pages/ProjectModule.tsx`（第 328~359 行） | 标题栏（返回 / 名称 / 目录类型标签）→ **「项目信息」Card**（`Descriptions` 三项 + 说明文案 + 导出按钮）→ **`<WorkingBar/>`** → `Tabs` |
| 前端 · 细条 | `web/src/pages/WorkingBar.tsx` | 常驻渲染：空闲时显示「当前没有 Agent 在工作」+ 空闲/暂停/队列合计 + 刷新；忙时显示占用者与两个停止按钮 |
| 前端 · 编排图 | `web/src/pages/TopologyPanel.tsx` | 2 栏（左画布 Card + 右 `RightColumn`）；画布 Card 的 `title/extra` 已放"添加 Agent / 连线模式 / 刷新 / 保存" |
| 后端 | `src/server/http-routes/{runtime,projects}.ts` | **本轮不改** |
| 文档 | `prd` D17-⑥、`design/ui.md` §2.1/§3/§4、`docs/README.md` §2/§3.4、`plan/development.md` §3/§6、`testing/plan.md` 规则 20 | D17-⑥ 写的是"全局进行中提示 MVP=**顶部细条**"，§3 未描述细条与「项目信息」卡，规则 20 提到"顶部「n 个 Agent 正在工作」" |

## 3 关键决定

1. **「项目信息」卡整卡删除，导出按钮上移到标题栏**（用户选择）：工作目录/描述/成员是"创建后基本不变"的静态信息，列表页已有名称/描述/工作目录列；详情页把首屏留给编排与会话。导出是**动作**不是信息，故保留并以 `Tooltip` 承载原说明文案，避免重新引入一行说明文字。
2. **细条只挂「拓扑」页**（用户选择"功能放在编排图的顶部"）：细条的作用是"看见谁在跑并就地刹车"，这与画布/节点状态是同一观测面（US-17"从图上观测整体工作情况"）；「对话」页本身已有会话内「停止生成」与右栏三列表。
3. **空闲不渲染整条**（用户选择）：`working.length === 0` 直接 `return null`——细条是"有事才出现"的运维带，不做空态占位；`snapshot.idle/paused/queuedTotal` 汇总也随之只在忙时出现。
4. **不删后端能力，也不新增接口**：`/runtime` 与 `/runtime/stop` 保留（细条仍是它们唯一的前端消费者）；「停止任务」的兜底入口 = 右栏任务列表把任务状态改为 `terminated`（平台先结算未结算改动，规则 17/26），因此删除页面级细条不产生能力真空。
5. **prd 记 D25**：D17-⑥ 的"顶部细条"是当年定案，位置与空态由本轮用户口径修订；同时把"项目详情页无信息卡、导出在标题栏"写进 `ui.md` §2.1（此前文档并未描述该卡片，属实现先行）。

## 4 实现步骤

- `web/src/pages/ProjectModule.tsx`
  - 标题栏改为"左：返回 / 名称 / 目录类型；右：导出按钮（`Tooltip` 包住）"，用外层 `Space` 的 `justifyContent: 'space-between'` 实现。
  - 删除「项目信息」`Card` 与 `Descriptions` 三项、说明文案；删除 `WorkingBar` 渲染与 import；移除 `Descriptions` import，新增 `Tooltip` import（`Card`/`Typography` 仍被其它区块使用，保留）。
- `web/src/pages/WorkingBar.tsx`
  - `working.length === 0` → `return null`；删掉 `Badge` 空态文案分支（`Badge` 在忙时仍用于"processing"圆点）；更新文件头注释（只在编排图顶部挂载、空闲不渲染）。
- `web/src/pages/TopologyPanel.tsx`
  - `import { WorkingBar } from './WorkingBar'`；`return` 外层由横向 `flex` 改为纵向 `flex`（`flexDirection: 'column'; gap: 12`），第一行放 `<WorkingBar projectId={projectId} />`，第二行保持原 2 栏 `div`。
- 文档回写：`prd` D25（含 D17-⑥ 行内修订标注）、`design/ui.md` §2.1/§3、`docs/README.md` §2（"运行细条"术语）与 §3.4（S15 行、标题改 `S0`~`S15`）、`plan/development.md` §3/§6、`testing/plan.md` 规则 20 与 §6 验收记录、`tests/acceptance/prd-section9.test.ts` 阶段清单加 `s15`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 回归 | `npm test` 全绿（本轮无后端改动，防回归）+ `npm run coverage` 触达门禁 + `npm run ratchet` |
| 产物冒烟 | 构建产物中不再包含 `当前没有 Agent 在工作` 与 `项目信息`；仍包含 `导出项目数据` 与 `个 Agent 正在工作` |
| 活体 | 隔离实例（临时 `data/`）启动后打开 `/`：进入项目 → 标签页上方无「项目信息」卡、标题栏右侧有导出按钮 → 「拓扑」页编排图上方空闲无细条 → 造一次运行（或直接检查 DOM 结构）确认忙时细条出现 |
| 说明 | 本仓库无前端测试设施（Vitest 仅覆盖 node 侧），UI 以 **构建 + 产物冒烟 + 代码审阅** 为准，与 S4/S7/S12 的 UI 交付口径一致；浏览器点击级验证需用户刷新页面确认 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户其实想去掉导出能力 | 本轮按"信息展示不需要、动作保留"理解；若导出也要删，只需再删标题栏那一个按钮（接口与后端能力独立保留） |
| 细条移出后"停止任务"找不到 | 右栏任务列表可把状态改为 `terminated`（平台先结算快照，规则 17/26）；`ui.md` §5 已如此描述，本轮在 §3 补一句指路 |
| 空闲不渲染导致"服务端错误"不可见 | 细条的 `error` 只在忙时有意义（要有东西才可停）；拓扑页加载失败另有 `Alert`（画布 Card 内），不会静默 |
