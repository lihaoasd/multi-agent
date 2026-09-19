# 修改记录 · S46 会话相互独立：「发送中」按会话记

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s46-sending-per-session.md](../plan/2026-09-16-s46-sending-per-session.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-12 / FR-29 / D49

## 1. 需求 / 问题

用户报告：**"不同角色间的会话是独立的，现在应该角色发送消息后，其他角色发不了。"**

根因（两处，都在前端）：

1. `SessionPanel` 用一个**全局 `busy`** 控制发送按钮的 `loading`；而 `POST /sessions/:sid/messages` **在服务端会 `await drain(...)`**——整个回合跑完才响应（模型调用 + 工具，可能几十秒，S31 已记录该语义）。于是给 A 发消息期间按钮一直转圈，**切到 B 也还是 loading**（antd 按钮 loading 时点击无效）→ B 发不出消息。
2. `loadEvents` 没有"会话是否已切换"的判断：A 的发送在切到 B 之后才返回时，`setEvents(A 的事件)` 会**覆盖 B 的会话流**。

后端本身是独立的（`drain` 按 `agent:<instanceId>` 各自串行，不同 Agent 不互相阻塞）——问题在于前端把"发送中"当成了全局状态。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/lib/sending.ts`（新） | 纯函数 `isSending(sending, sessionId)` / `withSending` / `withoutSending`（`readonly string[]` 存会话 id，幂等、不改原数组） |
| web | `web/src/pages/SessionPanel.tsx` | `busy` 由全局改为**按会话派生**（`isSending(sending, activeSessionId)`）；`send()` 先捕获 `sessionId`、`if (busy) return` 防重复提交、`finally` 用 `withoutSending(previous, sessionId)` 清除；新增 `activeSessionRef`（渲染期写入最新值），`loadEvents` 在 `setEvents` 前判断会话一致，**丢弃迟到响应** |
| tests | `tests/unit/web/sending.test.ts`（新 5） | 见 §4 |
| docs | `prd`（**D49** + FR-12/FR-29 补注）、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s46` | 全链路回写 |

**未改**：后端与接口（`POST /messages` 的"等整个回合"语义、`queued` 口径都不动）；S31 的乐观清空与失败回填；S45 的审批归属；左栏会话切换逻辑。

## 3. 关键决定

1. **状态粒度要对齐"会话独立性"**：会话之间互相独立，那么"发送中"也必须是**每会话**一份；抽成纯函数便于单测与复用。
2. **发送时捕获会话 id**：`send()` 一开始固定 `sessionId`，之后所有副作用（`loadEvents`、清除标记、失败回填）都基于它——用户中途切会话不会清错标记、也不会加载错会话。
3. **防重复提交按会话**：`if (busy) return`（busy 已是"当前会话在发送中"）；跨会话不受影响。
4. **迟到响应一律丢弃**：`activeSessionRef.current === sessionId` 才 `setEvents`——避免 A 的响应覆盖 B 的会话流。
5. **不改后端**：改成"立刻 202 + 后台跑回合"会牵动 `queued` 语义与大量等待式用例（S36/S37），属独立一轮，记入遗留。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 新增单测 | `sending.test.ts` **5 passed**：只影响被标记的会话（`u_dev_1` 发送中不影响 `u_qa_1`）/ 两个会话可同时发送中 / 标记与清除幂等且不改原数组 / 清除一个不影响另一个 / 未选中会话（`null`/空串）视为"没在发送" |
| 全量测试 | `npm test` **61 files / 387 tests 全绿**（S45 基线 60 / 382） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-D_xpswc1.js`（1,377.76 kB / gzip 431.31 kB） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— ① 给 A 发一条长任务消息（按钮转圈）→ 立刻切到 B：B 的发送按钮可点、能发出 ② 切回 A 时按钮仍在转圈（如实反映"这条还在处理"）③ B 发出后其会话流不被 A 的事件顶掉 |
| 说明 | 与 S15~S45 的交付口径一致 |

## 5. 遗留

- **平台语义未变**：`POST /sessions/:sid/messages` 仍要等整个回合跑完才响应（S31 记录在案）。要改成"立刻返回 202、回合后台跑"，需同时决定 `queued` 的新口径并改掉一批等待式用例（S36/S37 用它造"回合正在跑"的窗口），属独立一轮。
- **同一会话在途期间不能连发**：现在由 `if (busy) return` 拦住（与原先按钮 loading 的实际效果一致）；若要"同一会话也能连发排队"，把按钮改成可点 + 旁边给排队提示即可。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36/S37/S38/S39/S40/S41/S42/S43/S44/S45 记录）。
