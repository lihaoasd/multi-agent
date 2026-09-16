# 修改记录 · S18 删除边的可用性修复（点击热区 + 「删除选中边」按钮）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s18-edge-delete-affordance.md](../plan/2026-09-16-s18-edge-delete-affordance.md)
> 关联设计：[ui.md](../design/ui.md) §3、[prd](../requirements/prd.md) D26（编排图双模式）

## 1. 需求 / 问题

用户口径：**"删除边功能"** —— 追问后确认取 A：**"删不掉/选不中，修好并用一点"**。

现状：删除边其实有实现（边标签的 × → `removeEdge`，已核对 antd `Tag` 的关闭图标会 `stopPropagation` 后调 `onClose`），但**用不了/找不到**：

| 问题 | 原因 |
| --- | --- |
| 点线选不中 | SVG 线 `strokeWidth={2}`，命中区域就是这 2px，鼠标压不上去 |
| 选中了也没法删 | 选中只做高亮，画面上没有"删除"动作；唯一入口是画布**下方**边标签上的小 × |
| 选中后无法取消 | 没有任何取消选中的路径 |

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/TopologyPanel.tsx` | 每条边改为**两层**：透明热区线（`stroke="transparent"`、`strokeWidth={14}`、`pointerEvents: 'stroke'`、点击选中）+ 可见线（只绘制/高亮，`pointerEvents: 'none'`，不重复画箭头）；新增 `deleteSelectedEdge()`（按 `edge.id ?? 下标` 反查后走同一个 `removeEdge`）；编辑模式工具栏在「连线模式」后插入 **「删除选中边」**（`danger`，未选中禁用）；画布 `<svg>` 根节点 `onClick` 在编辑模式点空白时 `setSelectedEdge(null)`；画布下方说明补一句"删除边：点线选中后按「删除选中边」，或点边标签右侧的 ×；点空白处取消选中" |
| docs | `docs/design/ui.md` | §3「边」条目改写（14px 热区、两种删除入口、空白取消选中） |
| docs | `docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md` | 阶段索引 `S0`~`S18` + S18 行；§6 验收记录 |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 5 阶段清单加 `s18` |

**未改**：`prd`（无需求/验收口径变化，属 D26 的可用性修复）；后端与保存契约（`GET/PUT /api/projects/:pid/orchestration`、规则 22）原样。

## 3. 关键决定

1. **加宽热区而非加粗可见线**：可见线仍是 2px（选中 3px），画布不至于变脏；另叠一条 14px 的透明线专接点击，并显式 `pointerEvents: 'stroke'`（不依赖"透明描边算不算已绘制"的浏览器差异），可见线设 `pointerEvents: 'none'` 避免两层抢事件、箭头只画一次。
2. **把删除做成看得见的动作**：编辑模式工具栏加 danger 按钮「删除选中边」，未选中时禁用——"选中 → 删除"是用户预期的心智模型；边标签的 × 保留为第二入口，两者共用 `removeEdge(index)`，行为完全一致（都只改本地状态并置"未保存"，保存契约不变）。
3. **补上"取消选中"**：点画布空白清除选中（用 `event.target === event.currentTarget` 判定点在空白而非线上，线的点击冒泡到 svg 时该守卫不成立，不会误清）。
4. **严格限定在编辑模式**：浏览模式既不选中也不删除（沿用 S17 的 D26 口径）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsc -p tsconfig.json` + `tsc -p web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-Dzn5wB85.js`） |
| 产物冒烟 | 含 `删除选中边` 与 `删除边：点线选中` 提示文案 |
| 活体 | 服务端静态服务 `web/dist`：`GET /assets/index-Dzn5wB85.js` 200 |
| 回归 | `npm test` 全绿（规则 22/23、验收脚本 6 不受影响）；`npm run coverage` 141/141；`npm run ratchet` 违规 0 |
| **未覆盖** | 无浏览器自动化：需用户刷新后确认"点在离线 5~7px 处也能选中""选中后「删除选中边」可点且生效""点空白取消选中" |
| 说明 | 与 S4/S7/S12/S15/S16/S17 的 UI 交付口径一致：构建 + 产物冒烟 + 代码审阅 |

## 5. 遗留

- 不支持多选/框选批量删边（P1 范畴）；也不支持按 `Delete` 键删除选中边（如需可加，键盘事件需挂在画布容器上并避免与输入框冲突）。
- 拖拽节点后线的选中态会保留（几何变了、选中的仍是同一条边），不做自动取消。
- 快捷键、右键菜单等交互统一留待 P1（与 ui.md §3 现状一致）。
