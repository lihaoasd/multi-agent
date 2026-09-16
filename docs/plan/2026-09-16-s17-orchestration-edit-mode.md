# S17 方案：编排图交互修复 + 「浏览 / 编辑」双模式

> 日期：2026-09-16　类型：缺陷修复 + 需求变更（用户直接指令）　真源：`design/ui.md` §3（项目页 · 拓扑导航）、`prd.md` FR-28（由 D26 修订）
> 关联：`docs/changes/2026-09-16-s17-orchestration-edit-mode.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"编排图里，无法打开会话，无法连线，点击没反应，添加一个编辑模式，编辑模式下才可以删除，添加，连线"**。

拆成"一个缺陷 + 一条需求"：

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **缺陷修复**：点节点卡片能打开会话（不再是死按钮） | 浏览模式下点击任一 Agent 卡片 → 切到会话页并**选中该 Agent 的会话**（不是"上次停留的那个会话"） |
| R2 | **缺陷修复**：连线可用 | 编辑模式下：开「连线模式」→ 点起点节点 → 点目标节点 → 图上出现新边（自环/重复边仍被拒并提示） |
| R3 | **新增浏览 / 编辑双模式**（用户指令）：**默认浏览模式**；只有编辑模式能添加节点、连线、拖拽移动、移出节点、删除边 | 浏览模式工具栏只有「编辑 / 刷新」；进入编辑模式后才出现「添加 Agent / 连线模式 / 保存 / 退出编辑」；浏览模式下拖不动节点、删不掉边 |
| R4 | 编辑模式内按在按钮上不触发拖拽 | 点「移出图」不会让卡片跟着手指移动，且按钮确实生效 |
| R5 | 退出编辑模式时若存在未保存改动 → 二次确认（放弃并还原为最近保存版本 / 继续编辑） | 改点东西后点「退出编辑」→ 弹确认；选"放弃"→ 画布复原为服务端版本；选"继续编辑"→ 留在编辑模式 |
| R6 | 后端与保存契约不变 | `GET/PUT /api/projects/:pid/orchestration` 不变（编辑模式仅是前端开关；保存仍是带 `version` 的全量提交，规则 22） |

## 2 缺陷根因（已定位）

`web/src/pages/TopologyPanel.tsx` 的节点卡片：

```tsx
<div onPointerDown={(e) => onPointerDown(e, node)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
  ...
  <Button onClick={...}>打开会话 / 连到这里</Button>
</div>
```

`onPointerDown` 里对自己调用了 `event.currentTarget.setPointerCapture(event.pointerId)`。按 DOM 规范，**指针捕获会把后续指针事件（含 `pointerup`）重定向到捕获元素**；`click` 事件派发在 `pointerdown` 与 `pointerup` 两个目标的**最近公共祖先**上，而捕获后 `pointerup` 的目标就是这张卡片，公共祖先 = 卡片本身 → `click` 落在卡片上，**卡片内 `<button>` 的 `onClick` 永不触发**。

表现完全对得上用户描述：

- 「打开会话」点了没反应（事件根本不到按钮）；
- 「连到这里」同理 → **连线无法完成**（旧实现只能靠这个按钮选起点/终点）；
- 且每次点击都会进入拖拽态，观感上就是"点击没反应，但卡片会乱动"。

旧实现还有两处叠加问题：工具栏「连线模式」按钮把起点默认设成 `nodes[0]`（语义莫名其妙）；起点高亮与终点选择只能靠卡片内按钮，进一步放大了缺陷影响面。

## 3 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/TopologyPanel.tsx` | 单模式：拖拽/连线/删除与"打开会话"混在同一层；节点卡片指针捕获吞掉按钮点击；边删除标签常驻 `closable` |
| 前端 | `web/src/pages/ProjectModule.tsx` | `onOpenSession={() => setActiveTab('session')}` —— 只切标签页，**不带目标 Agent**，即使按钮能点也打不开"这个 Agent 的会话" |
| 前端 | `web/src/pages/SessionPanel.tsx` | `activeSessionId` 由内部 `?? list[0]` 决定，无外部聚焦入口 |
| 后端 | `src/server/http-routes/orchestration.ts` | **本轮不改** |

## 4 关键决定

1. **双模式而不是"补一个 stopPropagation"**：根因在指针捕获，最省事的修法是在按钮上 `stopPropagation`；但用户要的编辑模式本身也解决了语义问题——**浏览模式不挂任何指针事件**（根本不存在捕获），编辑模式才挂拖拽。因此按"浏览/编辑"重构，顺带彻底消除捕获吞点击的可能。
2. **浏览模式点击即开会话，编辑模式点击不跳转**：浏览模式下"点卡片=进这个 Agent 的会话"，与 §3 里"点节点自动跳到该 Agent 的会话"一致；编辑模式下点击只用于连线选点，避免编辑时误跳页。
3. **把"连到这里"从按钮改为节点点击**：连线流程 = 开「连线模式」→ 点起点 → 点终点（`connectFrom` 高亮）；连完一条自动清空起点、保持连线模式可继续连下一条。工具栏按钮不再"默认挑第一个节点当起点"。
4. **未保存改动不静默丢弃**：退出编辑模式时若 `dirty`，弹确认；确认后 `load()` 还原服务端版本（`dirty` 复位）。
5. **"打开会话"要落到正确的会话**：`ProjectModule` 把 `{instanceId, at}` 作为一次性聚焦请求传给 `SessionPanel`，后者按 `instanceId` 选中对应会话（用 `at` 作为幂等令牌，保证重复点同一节点也能再次聚焦）。否则点 dev 的卡片却停在 pm 的会话上，等于没修好。
6. **保存语义不变**：仍是整图全量提交（`version` 乐观并发），编辑模式只是"何时允许产生本地改动"的前端闸门。

## 5 实现步骤

- `web/src/pages/TopologyPanel.tsx`
  - 状态：`editing`（默认 `false`）、`connectMode`（默认 `false`）、`connectFrom`、`selectedEdge`、`dirty`。
  - `onPointerDown`：`if (!editing) return`；`if (event.target.closest('button') !== null) return`（按在按钮上不拖拽、不捕获）；再 `setPointerCapture`。
  - `onPointerMove/onPointerUp`：仅 `editing` 且 `dragRef.current !== null` 时生效。
  - 节点卡片 `onClick`：浏览 → `onOpenSession?.(node.instanceId)`；编辑 → `connectMode ? connect(node.instanceId) : undefined`。
  - 节点按钮：浏览 → 「暂停/继续」；编辑 → 「移出图」；两者 `onClick` 均 `event.stopPropagation()`。
  - 工具栏：浏览 =「编辑 / 刷新」；编辑 =「添加 Agent 下拉 / 连线模式 / 刷新 / 保存 / 退出编辑」。
  - 边：SVG 线点击选中仅编辑模式；下方边标签 `closable` 仅编辑模式；`removeEdge` 仅编辑模式可达。
  - 退出编辑：`dirty` 时 `Modal.confirm` 二次确认（放弃 → `load()`）。
  - 空态文案按模式区分（浏览："从 Agent 库添加成员"；编辑："点右上角「添加 Agent」把成员放进图中"）。
- `web/src/pages/ProjectModule.tsx`：`sessionFocus` 状态 `{instanceId, at}`；`onOpenSession={(instanceId) => { setSessionFocus({instanceId, at: Date.now()}); setActiveTab('session') }}`；`<SessionPanel projectId={current.id} focus={sessionFocus} />`。
- `web/src/pages/SessionPanel.tsx`：新增可选 `focus` 属性 + 一次性聚焦效果（`appliedAtRef` 防重复，找不到会话时等 `sessions` 更新后再试）。
- 文档回写：`prd` 新增 **D26**（修订 FR-28 与 ui.md §3）、`design/ui.md` §3 重写交互条目、`README.md`/`development.md`/`testing/plan.md` 索引与记录、验收阶段清单加 `s17`。

## 6 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 产物冒烟 | 产物包含 `编辑模式`/`退出编辑`/`连线模式` 等新模式文案，且不再包含旧文案 `连到这里` |
| 活体（接口层） | 服务端静态服务 `web/dist`：`GET /assets/<新产物>.js` 200；`GET /api/projects/:pid/orchestration` 与 `PUT`（带 `version`）行为不变（规则 22 用例复跑） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` |
| **交互验证（用户）** | 本仓库**无前端测试设施、也无浏览器自动化**，指针/点击类交互无法由我点击验证：需用户刷新后按 R1~R5 逐条点一遍（点卡片开对应会话、编辑模式连线、退出编辑确认、浏览模式拖不动） |
| 说明 | 与 S4/S7/S12/S15/S16 的 UI 交付口径一致；本次额外把"根因（指针捕获吞点击）"写进改动记录，便于日后回归 |

## 7 风险

| 风险 | 对策 |
| --- | --- |
| 修复后仍有个别点击不灵（例如 antd Select 下拉） | 浏览模式不再挂任何指针事件；编辑模式的拖拽只从卡片空白处启动，并显式跳过 `button` 目标 |
| 用户其实想"浏览模式也能拖拽" | 拖拽仅在编辑模式；若要放开，只需把 `onPointerDown` 的 `editing` 分支拆开（改动局限在一个守卫条件） |
| 聚焦会话的令牌机制引入重复选中 | 用 `at` 令牌 + 只在"匹配到会话"时记录已应用，切换/刷新会话列表不会覆盖用户的手动选择 |
| 退出编辑导致误丢改动 | 有 `dirty` 才弹确认，且确认文案明确"放弃并还原为最近保存版本" |
