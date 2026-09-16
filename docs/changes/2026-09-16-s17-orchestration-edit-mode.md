# 修改记录 · S17 编排图交互修复 + 「浏览 / 编辑」双模式

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s17-orchestration-edit-mode.md](../plan/2026-09-16-s17-orchestration-edit-mode.md)
> 关联设计：[ui.md](../design/ui.md) §3、[prd](../requirements/prd.md) D26 / FR-28、[orchestration.md](../design/orchestration.md) §3

## 1. 需求 / 问题

用户报告：**"编排图里，无法打开会话，无法连线，点击没反应"**，并要求**"添加一个编辑模式，编辑模式下才可以删除，添加，连线"**。

### 根因（已定位并修复）

`web/src/pages/TopologyPanel.tsx` 的节点卡片在 `onPointerDown` 里对自身调用了 `event.currentTarget.setPointerCapture(event.pointerId)`。

按 DOM 规范：**指针捕获把后续指针事件（含 `pointerup`）重定向到捕获元素**，而 `click` 事件派发在 `pointerdown` 与 `pointerup` 两个目标的**最近公共祖先**上 —— 捕获后 `pointerup` 的目标就是这张卡片，公共祖先 = 卡片，于是 `click` 落在卡片上，**卡片内 `<button>` 的 `onClick` 永不触发**。表现与用户描述完全一致：

| 现象 | 原因 |
| --- | --- |
| 「打开会话」点了没反应 | 事件到不了按钮；且旧代码把"打开会话"做成了卡片内按钮 |
| 无法连线 | 旧实现只能在卡片内点「连到这里」选起点/终点，同一个按钮点击失效 |
| "点击没反应"（但卡片会动） | 每次点击都会先进入拖拽态，`setPointerCapture` 生效 |

叠加问题：工具栏「连线模式」的起点被默认设成 `nodes[0]`（语义不明），进一步掩盖了"按钮失效"这件事。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/TopologyPanel.tsx` | 新增 `editing`（默认 `false`）/`connectMode` 状态；**浏览模式不挂指针事件**、点卡片 = `onOpenSession(instanceId)`；编辑模式才拖拽，且 `event.target.closest('button') !== null` 时不拖拽不捕获；`onPointerUp` 加 `hasPointerCapture` 守卫；工具栏按模式切换（浏览＝编辑/刷新；编辑＝添加 Agent/连线模式/刷新/保存/退出编辑）；连线改为"开连线模式 → 点起点（高亮）→ 点目标"；删边（线点击选中 + 标签 `closable`）与「移出图」仅编辑模式；`toggleEditing()` 在 `dirty` 时 `Modal.confirm`（放弃 → `load()` 还原）；编辑模式下「刷新」也走 `reload()` 确认（避免静默丢弃画布改动）；标题区分浏览/编辑 |
| web | `web/src/pages/ProjectModule.tsx` | 新增 `sessionFocus {instanceId, at}`；`onOpenSession={(instanceId) => { setSessionFocus({instanceId, at: Date.now()}); setActiveTab('session') }}`；`<SessionPanel focus={sessionFocus} />` |
| web | `web/src/pages/SessionPanel.tsx` | 新增可选 `focus` 属性 + 一次性聚焦效果（`appliedFocusRef` 防重复；未匹配到会话时等 `sessions` 更新再试，且不覆盖用户手动选择） |
| docs | `docs/requirements/prd.md` | 新增 **D26**；FR-28 改写为双模式口径；文件头日期行增补 D26 |
| docs | `docs/design/ui.md` | §3 重写（工具栏、双模式、连线流程、编辑与保存、未保存提示、观测），头部决策依据补 D26 |
| docs | `docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md` | 阶段索引 `S0`~`S17` + S17 行；§5 规则 22/23 映射补注；§6 验收记录 |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 5 阶段清单加 `s17` |

**后端未改**：`GET/PUT /api/projects/:pid/orchestration` 契约、校验（自环/重复边/跨项目/`version`）与测试全部保持原样；编辑模式只是前端闸门。

## 3. 关键决定

1. **按模式重构，而不是只补 `stopPropagation`**：浏览模式**完全不挂指针事件**，从根上杜绝"捕获吞点击"；编辑模式才挂拖拽，并在 `pointerdown` 时显式跳过按钮目标（否则编辑模式里「移出图」又会被拖拽吃掉）。
2. **浏览模式点卡片 = 打开该 Agent 的会话**：与 ui.md §3「点节点自动跳到该 Agent 的会话」一致；编辑模式点击只用于连线选点，避免编辑时误跳页。
3. **"打开会话"必须落到正确的会话**：旧实现只切标签页（停在"上次那个会话"）。现在由 `ProjectModule` 传 `{instanceId, at}`，`SessionPanel` 按 `instanceId` 选中；`at` 作为幂等令牌，重复点同一节点也能再次聚焦，且**不会**在会话列表刷新时覆盖用户的手动选择。
4. **未保存改动不静默丢弃**：退出编辑模式时若 `dirty` → 二次确认；确认后 `load()` 还原服务端版本（`dirty` 复位）。编辑模式下的「刷新」同样先确认（否则一次刷新就把画布改动悄悄丢掉，与退出编辑的口径不一致）。
5. **保存语义零变化**：仍是整图全量提交（带 `version`），版本冲突提示不变（规则 22 用例复跑通过）。
6. **不引入新依赖/自动化**：不新增 React Flow 或浏览器自动化（本仓库无前端测试设施），交互验证交由用户点验，并把根因写进本记录以便回归。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsc -p tsconfig.json` + `tsc -p web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-CJaFYycK.js`） |
| 产物冒烟 | 含 `编辑模式`、`退出编辑`、`连线模式：点起点`、`移出图`、`放弃并退出`、`放弃并刷新`；**不再含**旧的 `连到这里` 与 `打开会话`（旧按钮路径已删除） |
| 活体 | 服务端静态服务 `web/dist`：`GET /assets/index-CJaFYycK.js` 200；`GET /api/projects/:pid/orchestration` 与 `PUT`（含 `version`）行为不变 |
| 回归 | `npm test` 全绿（规则 22/23、验收脚本 6 均未受影响）；`npm run coverage` 141/141；`npm run ratchet` 违规 0 |
| **未覆盖** | **指针/点击类交互无浏览器自动化可用**，R1~R5（点卡片开对应会话、编辑模式连线、退出编辑确认、浏览模式拖不动、按按钮不拖拽）需用户刷新页面后点验 |
| 说明 | 与 S4/S7/S12/S15/S16 的 UI 交付口径一致：构建 + 产物冒烟 + 代码审阅 |

## 5. 遗留

- **浏览器离开/刷新时的未保存提示仍未实现**（ui.md §3 已标注为 P1）：现在只在标题显示"· 未保存" + 退出编辑时确认。要做需加 `beforeunload`（属新需求）。
- 编辑模式不做"自动布局"（ui.md §3 的工具栏草图里曾出现该字样，实现从未提供，本轮草图已按真实实现改写）。
- 节点卡片不再有"右键菜单 / 停止 / 从图中删除"等右键交互（实现一直是按钮形态，ui.md 已按真实实现回写）；「停止任务」仍在右栏任务列表与编排图顶部的运行细条（S15）。
- 连线只能表达"允许委派"的有向边，暂不支持批量连线/框选多选（P1 范畴）。
