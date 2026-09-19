# S48 方案：修「应用挂了」——实时帧不再每帧触发整页重渲染

> 日期：2026-09-19　类型：用户报告（"应用挂了，和暂停，审批和询问都失效，不显示在前端"）　真源：`design/ui.md` §4、`api/contract.md` §3
> 关联：`docs/changes/2026-09-19-s48-realtime-render-storm.md`、`docs/plan/development.md`

## 1 需求

用户口径：**应用挂了；暂停、审批、询问都失效、不显示在前端。**

## 2 现场诊断（先证伪"后端挂了"）

| 检查 | 结果 |
| --- | --- |
| 后端 `:3000/health`、`/api/projects` | **200** ✓ |
| 前端 `:5173/`、`5173/api/projects`（vite 代理） | **200** ✓ |
| WS 直连 3000 / 经 vite 代理 5173 | 都能连、9 秒各收到约 **2400 帧**（代理正常） ✓ |
| 前端模块（`SessionPanel.tsx` 等经 vite 转译） | 全部 200，无转译错误 ✓ |
| 待办数据 | `questions?status=pending` = `[]`、`approvals?status=pending` = `[]`——**确实没有待办**（store 里最后一条是 `answered`/`approved`，也就是用户此前已经处理过） ✓ |
| **WS 帧速率** | 6 秒 933 帧 ≈ **155 帧/秒**，其中 **`message.chunk` 926 条（154/s）** ← 决定性证据 |

结论：**不是后端挂了，是前端被"每帧一次状态更新"刷爆了。**

## 3 根因

`web/src/hooks/useRealtime.ts` 原先在 `socket.onmessage` 里：

```ts
setFrames((previous) => [...previous.slice(-(MAX_FRAMES - 1)), frame])   // ← 每帧一次 state 更新
handlerRef.current?.(frame)
```

流式输出时 `message.chunk` 每秒上百帧 → **每秒上百次 state 更新 + 数组复制 + 整个页面重渲染**；
而会话流里每条对话消息都要走 `react-markdown` 解析（S27），于是每次重渲染都要重解析几十条历史消息
→ 主线程被占满：**页面卡死、按钮点不动、询问/审批卡也刷不出来**——正是用户描述的现象。
（`realtime.frames` 这个状态**没有任何消费方**，纯属白付代价。）

## 4 修复

1. **帧不进 React 状态**（`useRealtime`）：帧直接交给 `onFrame`；只保留一个**按 500ms 节流**的
   `frameCount`（可用于状态栏/调试），把 `frames` 数组整个去掉（无人使用）。
2. **行级记忆化**（新增 `web/src/components/EventRowView.tsx` + `memo`）：把会话流"一行怎么渲染"
   抽成纯展示组件，`visibleEvents.map(...)` 改用它——追加新事件只渲染新那一行，
   历史行（尤其是 Markdown 消息）不再被反复重解析。
3. **删除 SessionPanel 里已不再使用的导入**（`Collapse`/`Markdown`/`eventRow`/`isToolFailed`/`messageTextOf`），
   保持"一行的渲染只在一处"（S24/S26/S28/S34/S41/S44 的口径集中到 `EventRowView`）。

**不改**：WS 帧的**服务端**发送节奏（仍是逐字 `message.chunk`，语义与契约不变）；`event.appended` 的增量拉取逻辑；后端任何行为。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 实测证据 | WS 帧速率：6 秒 933 帧（`message.chunk` 926）；修复后帧速率不变（100/s），但**前端不再按帧 setState**（代码层面无 per-frame state 更新） |
| 前端可用性 | vite 转译 `useRealtime.ts`／`EventRowView.tsx`／`SessionPanel.tsx` 均 200（模块能编译、页面能加载） |
| 回归 | `npm test`（63 files / 392 tests）、`coverage` 143/143、`ratchet` 0、`typecheck`（src+web）、`eslint`、`npm run build` |
| **用户点验** | ① **硬刷新页面**（Ctrl+Shift+R，清掉长时间 HMR 的旧状态）② 会话流仍在实时增长，但滚动/点击**不再卡** ③「暂停」「停止生成」「到会话里答复」「批准/拒绝」都能点、状态随之变化 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 去掉 `frames` 后有人想读历史帧 | 全仓检索确认**无消费方**；类型里也不再有该字段（编译期即可发现） |
| `memo` 因 props 变化失效 | props 只有 `event`（对象引用在一次拉取内稳定）；行内不再依赖任何外部可变状态 |
| 帧仍然很密（~100/s）占带宽 | 目前每帧只是几十字节的文本增量，实测代理链路无压力；若将来要做"边流边看"的实时打字，应在**服务端合并增量**（记遗留） |
| 页面仍可能被"事件增长"拖慢 | 行级 memo 已解决历史重渲染；若单会话事件上万，需要虚拟滚动（未做，记遗留） |

## 7 遗留

- **服务端仍逐字推送 `message.chunk`**：本轮只修"前端按帧 setState"；若要实时打字效果，建议在服务端按 ~50ms 合并增量后再广播（会改变"一帧一小段"的粒度，属独立一轮）。
- **无虚拟滚动**：会话窗口一次最多渲染 200 条（`sessionApi.detail(..., 200)`）；条数再涨需要虚拟列表。
- **HMR 长时间累积**：开发期反复热更新可能让页面处于半更新状态，遇到"怪现象"先**硬刷新**。
