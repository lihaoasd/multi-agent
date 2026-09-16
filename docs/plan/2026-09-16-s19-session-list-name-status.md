# S19 方案：会话页 Agent 列表只保留名称与状态

> 日期：2026-09-16　类型：UI 简化（用户直接指令）　真源：`design/ui.md` §4（对话导航 3 栏 · 会话切换）
> 关联：`docs/changes/2026-09-16-s19-session-list-name-status.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"会话页的 agent 列表，不要显示任务，只需要写 agent 名称和状态"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 左栏会话列表项**不再显示第二行文本**（最后一条消息预览 `lastMessagePreview`，任务派单时常呈现为"请开始执行任务 t_…"之类的任务文本） | 列表项只占一行；`（暂无消息）` 文案不再出现 |
| R2 | 列表项 = **Agent 名称 + 状态** | 每项显示 Agent 显示名 + 状态标签：`工作中`（蓝）/ `等待中`（橙）/ `空闲`（灰），暂停时显示 `已暂停`（紫） |
| R3 | 其余多余信息一并收敛 | 不再显示「排队 n」标签（队列数仍可在对话页底部状态行与拓扑页节点卡片看到）；归档会话保留「已归档」标记（否则只读会话无解释） |
| R4 | 选中态仍清晰、标签可读 | 选中项用**浅蓝底 + 蓝边**（不再是实心蓝按钮），状态标签在浅底上颜色可读 |
| R5 | 不改数据与接口 | `GET /api/projects/:pid/sessions`、`/agents` 契约不变；后端零改动 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx`（左栏 `Card title="会话（每个 Agent 一个）"`） | 每项是一个 `Button`（选中=实心蓝 `primary`），内容为：`Badge` 圆点 + Agent 名（**状态只由圆点颜色表达，没有文字**）+ 「已归档」/「排队 n」标签 + 第二行最后消息预览 |
| 前端 | `web/src/api/sessions.ts` | `SessionSummary.lastMessagePreview` 字段保留（本轮只是不展示；后端仍返回） |
| 后端 | `src/server/http-routes/sessions.ts` | **本轮不改** |

## 3 关键决定

1. **状态要有文字，而不只是一个圆点**：用户要"名称和状态"，而现状是"名称 + 只有圆点表意的状态"。因此改成显式状态标签（空闲/工作中/等待中/已暂停），并去掉与之重复的 `Badge` 圆点。
2. **状态口径沿用运行期真相**：状态取自 `GET /api/projects/:pid/agents`（`AgentStatus.state` + `paused`），与拓扑页节点卡片、运行细条同源，不新增前端推导。
3. **去掉第二行预览**：`lastMessagePreview` 是"任务/消息文本"的来源，正是用户点名不要的内容；对话内容本身在中间栏可见，列表不需要重复。
4. **去掉「排队 n」**：它不属于"名称与状态"；活跃会话的队列数在对话页底部状态行（`… ｜排队 N 条`）与拓扑页节点卡片（`队列 n`）仍然可见，信息不丢失。
5. **保留「已归档」**：`session.state === 'archived'`（实例停用后的会话只读）是**会话状态**而非任务信息，去掉会让只读会话无从解释。
6. **选中态从实心蓝改为浅蓝底**：状态标签（蓝/橙/紫）在实心蓝按钮上对比度差；浅蓝底 + 蓝边既保留选中辨识度，也让标签颜色可读。

## 4 实现步骤

- `web/src/pages/SessionPanel.tsx`
  - 新增模块级常量与纯函数：`AGENT_STATE_LABEL`/`AGENT_STATE_COLOR` + `agentState(status)`（`paused` 优先返回「已暂停」）。
  - 列表项：`type={active ? 'default' : 'text'}` + 选中时 `background:'#e6f4ff'`/`borderColor:'#91caff'`；内容改为 `名称（strong） + 状态标签 + [已归档]`；删除第二行预览与「排队 n」标签、删除 `Badge` 使用与 import。
- 文档回写：`design/ui.md` §4「会话切换」条目；`README.md`/`plan/development.md`/`testing/plan.md` 索引与记录；验收阶段清单加 `s19`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 产物冒烟 | 产物含 `工作中`/`等待中`/`已暂停`，**不含** `（暂无消息）` |
| 活体 | 服务端静态服务 `web/dist`：`GET /assets/<新产物>.js` 200 |
| 回归 | `npm test` 全绿（本轮无后端改动）+ `npm run coverage` + `npm run ratchet` |
| **交互验证（用户）** | 无浏览器自动化：刷新后确认列表只有名称+状态、选中项浅蓝底、暂停的 Agent 显示「已暂停」 |
| 说明 | 与 S4/S7/S12/S15~S18 的 UI 交付口径一致 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户其实想连「排队 n」也保留 | 只影响一个标签的渲染：把它加回 `Space` 即可（`status.queued` 仍在手） |
| 状态数据缺失（`statuses` 尚未加载） | `agentState(undefined)` 兜底为「空闲」，不会出现空白项 |
| 去掉预览后难以快速分辨会话 | 名称唯一（每 Agent 一个会话）+ 状态标签已足够；预览在中间栏可见。若后续要"最近一条消息"提示，应作为独立的未读/摘要特性（P1） |
