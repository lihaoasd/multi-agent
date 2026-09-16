# S18 方案：删除边的可用性修复（点击热区 + 「删除选中边」按钮）

> 日期：2026-09-16　类型：缺陷修复 / 可用性（用户直接指令，二选一确认取 A）　真源：`design/ui.md` §3、`prd.md` D26
> 关联：`docs/changes/2026-09-16-s18-edge-delete-affordance.md`、`docs/plan/development.md`

## 1 需求

用户口径：**"删除边功能"** → 追问确认后选 **A："删不掉/选不中，修好并用一点"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **点线即可稳定选中**（编辑模式） | 线的点击热区从 2px 扩到 14px（透明粗线 + `pointerEvents: 'stroke'`）；点在箭头附近 7px 内即选中，选中后线变蓝并加粗 |
| R2 | 编辑模式工具栏新增**「删除选中边」**（未选中时禁用） | 选中一条边 → 按钮可用 → 点击后该边从画布与边标签列表消失；未选中时按钮灰置 |
| R3 | **点空白处取消选中**（编辑模式） | 选中一条边后点画布空白 → 高亮取消、「删除选中边」重新变灰 |
| R4 | 边标签的 × 保留，两条路径行为一致 | 用 × 删除与用按钮删除结果相同（都只改本地状态并置"未保存"） |
| R5 | 浏览模式不变；保存契约不变 | 浏览模式点线不选中、无删除入口；仍需编辑模式 + 保存（带 `version` 全量提交，规则 22 不变） |

## 2 缺陷与现状

| 面 | 现状 | 问题 |
| --- | --- | --- |
| `web/src/pages/TopologyPanel.tsx` 的 SVG 线 | `<line strokeWidth={2} onClick={选中}>` | **命中区域就是那 2px**，鼠标很难压在线上 → "选不中"；且选中之后画面上没有任何"删除"动作，只能去画布下方的边标签点小 × → 观感就是"删除边功能没有" |
| 边标签列表 | `<Tag closable={editing} onClose={removeEdge}>` | 功能本身可用（antd Tag 的关闭图标会 `stopPropagation` 后调 `onClose`，已核对 `node_modules/antd/es/tag/index.js`），但入口在画布下方、尺寸小，不易发现 |
| 取消选中 | 无 | 选中后无法取消，只能靠删掉或刷新 |

## 3 关键决定

1. **加宽热区而不是加粗可见线**：可见线保持 2px（选中 3px）以免画布变脏；在它下面叠一条 `stroke="transparent"` + `strokeWidth={14}` 的线专门接点击，并显式设 `pointerEvents: 'stroke'`（不依赖浏览器对透明描边是否算"已绘制"的判断），同时给可见线 `pointerEvents: 'none'` 避免两层抢事件。
2. **显式动作放到工具栏**：选中态需要一个看得见的"删除"，做成编辑模式工具栏的 danger 按钮（未选中禁用）；边标签的 × 保留为第二入口，两者共用同一个 `removeEdge(index)`。
3. **点空白取消选中**：SVG 根节点 `onClick` 里判断 `event.target === event.currentTarget`（即点在空白处而非线上），选中态清零；这条不干扰线上点击（线的点击目标是线，冒泡到 svg 时守卫不成立）。
4. **不改浏览模式与保存契约**：S17 的双模式闸门与后端全量提交语义原样保留。

## 4 实现步骤

- `web/src/pages/TopologyPanel.tsx`
  - 每条边渲染两层：透明热区线（14px，`pointerEvents: 'stroke'`，点击 → `setSelectedEdge(key)`）+ 可见线（`pointerEvents: 'none'`，仅绘制与高亮）。
  - 新增 `deleteSelectedEdge()`：按 `edge.id ?? position` 反查下标后调用既有 `removeEdge(index)`。
  - 编辑模式工具栏在「连线模式」后插入 `删除选中边`（`danger`，`disabled={selectedEdge === null}`）。
  - 画布根 `<svg onClick>`：编辑模式且点在空白处 → `setSelectedEdge(null)`。
  - 画布下方说明文字：编辑模式追加一句指向两个删除入口的提示。
- 文档回写：`design/ui.md` §3「边」条目；`README.md`/`development.md`/`testing/plan.md` 索引与记录；验收阶段清单加 `s18`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 产物冒烟 | 产物含 `删除选中边` 与热区相关文案（`删除边：点线选中`），不再依赖 2px 命中 |
| 活体 | 服务端静态服务 `web/dist`：`GET /assets/<新产物>.js` 200 |
| 回归 | `npm test` 全绿（规则 22/23 与验收脚本 6 不受影响）+ `npm run coverage` + `npm run ratchet` |
| **交互验证（用户）** | 无浏览器自动化：需用户刷新后在编辑模式点线（含离线 5~7px 处）确认选中、点「删除选中边」确认删除、点空白确认取消选中 |
| 说明 | 与 S4/S7/S12/S15/S16/S17 的 UI 交付口径一致 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 热区变宽后"想点空白却点到线" | 14px 已是常见折中（约手指/鼠标可稳定命中）；点空白取消选中的判定基于 `event.target`，不会误清 |
| 两层线导致箭头 marker 重复 | 热区线不设 `markerEnd`，箭头只由可见线绘制 |
| 选中态在连线/拖动后残留 | 删除、点空白、刷新、退出编辑都会清空 `selectedEdge`（既有 `removeEdge`/`load`/`toggleEditing` 路径） |
