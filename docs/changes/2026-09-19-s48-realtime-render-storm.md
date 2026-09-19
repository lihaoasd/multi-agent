# 修改记录 · S48 修「应用挂了」：实时帧不再每帧触发整页重渲染

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s48-realtime-render-storm.md](../plan/2026-09-19-s48-realtime-render-storm.md)
> 关联设计：[ui.md](../design/ui.md) §4、[contract.md](../api/contract.md) §3、[prd](../requirements/prd.md) FR-30 / D51

## 1. 需求 / 问题

用户报告：**"应用挂了，和暂停，审批和询问都失效，不显示在前端。"**

### 先证伪"后端挂了"（现场实测）

| 检查 | 结果 |
| --- | --- |
| 后端 `:3000/health` / `/api/projects` | **200** |
| 前端 `:5173/` 与 `5173/api/projects`（代理） | **200** |
| WS：直连 3000 / 经 vite 代理 5173 | 都能连；9 秒各收约 **2400 帧**（代理链路正常） |
| 前端模块（`SessionPanel.tsx` 等由 vite 转译） | 全部 200，无转译错误 |
| 待办 | `questions?pending`=[]、`approvals?pending`=[]——**确实没有待办**（store 里最后一条分别是 `answered`/`approved`，即用户已处理过） |
| **WS 帧速率** | 6 秒 933 帧 ≈ **155 帧/秒**，其中 **`message.chunk` 926 条（154/s）** |

→ **不是后端挂了，是前端被"每帧一次状态更新"刷爆了。**

### 根因

`web/src/hooks/useRealtime.ts` 每收到一帧就 `setFrames((prev) => [...prev.slice(-199), frame])`：
流式输出时每秒上百帧 ⇒ **每秒上百次 state 更新 + 数组复制 + 整页重渲染**；会话流每条对话消息还要走
`react-markdown`（S27）重新解析，几十条历史消息被反复重解析 ⇒ 主线程占满 ⇒ **页面卡死、按钮点不动、
询问/审批卡刷不出来**。而 `realtime.frames` 这个状态**没有任何消费方**。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/hooks/useRealtime.ts` | **帧不再进 React 状态**（直接交给 `onFrame`）；删掉 `frames` 数组与每帧 `setState`，改为**按 500ms 节流**的 `frameCount`（仅供状态/调试）；`RealtimeState` 相应调整 |
| web | `web/src/components/EventRowView.tsx`（新） | 会话流"一行怎么渲染"抽成**纯展示 + `memo`** 组件（消息 Markdown 行 / 思考 / 计划 / 工具调用与结果 / 错误），props 只有 `event` |
| web | `web/src/pages/SessionPanel.tsx` | 会话流改为 `visibleEvents.map((event) => <EventRowView key={event.seq} event={event} />)`；删除随之不再使用的导入（`Collapse`/`Markdown`/`eventRow`/`isToolFailed`/`messageTextOf`） |
| tests | — | 本轮为前端性能修复：无 DOM 测试设施，无法自动化（沿用既有"前端交互须用户点验"口径） |
| docs | `prd`（**D51** + FR-30 补注）、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s48` | 全链路回写 |

**未改**：服务端 WS 推送节奏（仍逐字推 `message.chunk`，契约不变）；`event.appended` 增量拉取；后端任何行为；S42 的"输入框上方等待提示"逻辑（`message.chunk` 仍被消费，只是不再触发重渲染）。

## 3. 关键决定

1. **"帧"不是 UI 状态**：帧是**事件流**，用 React state 承载它等于"每次网络事件强制一次渲染"。改成直接回调 + 节流计数器。
2. **行级 `memo`**：会话流是"只追加"的列表，追加时历史行必须原地复用；`memo` 的 props 只有 `event`（一次拉取内引用稳定）。
3. **渲染口径集中一处**：一行的渲染规则本来就在 `eventRow`（纯函数），本轮把**渲染**也收进 `EventRowView`，SessionPanel 只负责"取数 + 排列"。
4. **不动服务端**：帧速率本身不是问题（每帧几十字节）；问题在客户端把它当状态。若将来要做实时打字，才需要在服务端合并增量（记遗留）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 实测（修复前） | WS 6 秒 933 帧 ≈ 155 帧/秒（`message.chunk` 926）→ 前端每帧一次 state 更新 |
| 实测（修复后） | 帧速率不变（约 100/s），但**不再有按帧的 state 更新**（代码层面消除）；vite 转译 `useRealtime.ts`/`EventRowView.tsx`/`SessionPanel.tsx` 均 200 |
| typecheck / eslint | 0 错误（src + web） |
| 全量测试 | `npm test` **63 files / 392 tests 全绿** |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-DwJmzzL6.js`（1,377.92 kB / gzip 431.37 kB；EventRowView 抽出后体积基本持平） |
| **未覆盖** | 前端性能与交互无自动化：**须用户点验** —— ① **硬刷新**页面（Ctrl+Shift+R）② 会话流实时增长但滚动/点击不卡 ③「暂停」「停止生成」「到会话里答复」「批准/拒绝」都能点且状态随之变化 |
| 说明 | 与 S15~S47 的交付口径一致 |

## 5. 遗留

- **服务端仍逐字推送 `message.chunk`**：本轮只修客户端"按帧 setState"；要做 ChatGPT 式实时打字，应在服务端按 ~50ms 合并增量再广播（改变"一帧一小段"的粒度，属独立一轮）。
- **无虚拟滚动**：会话窗口一次最多渲染 200 条（`sessionApi.detail(..., 200)`）；事件再涨需要虚拟列表。
- **`sessionApi.log` 仍按事件逐个拉取**：`event.appended` 帧现在约 1/s（不重要）；若将来事件率上升，应把多次拉取合并成一次（去抖 + 合并 fromSeq）。
- **开发期 HMR 长时间累积**：反复热更新可能让页面处于半更新状态——遇到"怪现象"先硬刷新（本次排查的第一步）。
