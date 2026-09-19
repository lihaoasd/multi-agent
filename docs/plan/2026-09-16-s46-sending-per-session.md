# S46 方案：会话相互独立——"发送中"按会话记（一个角色发消息不再卡住别人）

> 日期：2026-09-16　类型：用户报告（"不同角色间的会话是独立的，现在应该角色发送消息后，其他角色发不了"）　真源：`design/ui.md` §4、`prd.md` FR-12 / FR-29
> 关联：`docs/changes/2026-09-16-s46-sending-per-session.md`、`docs/plan/development.md`

## 1 需求

用户口径：**不同角色间的会话是独立的；现在一个角色发消息之后，其他角色发不了。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 给 A 发消息**不影响** B 的发送 | 给 A 发消息后立刻切到 B，B 的「发送」按钮**可点**、能正常发出 |
| R2 | 同一会话防重复提交 | 同一条消息在途时，重复点/回车不会重复发送 |
| R3 | 迟到的响应不串会话 | A 的发送在切到 B 之后才返回时，**不能**用 A 的事件覆盖 B 的会话流（本次顺带修） |
| R4 | 发送仍需按会话各自显示进度 | 只有"正在发送的那条会话"按钮转圈（如实反映平台语义） |
| R5 | 不改后端 | 复用既有接口；平台语义（`POST /messages` 等整个回合）不变 |

## 2 现状与根因

| # | 位置 | 问题 |
| --- | --- | --- |
| ① | `web/src/pages/SessionPanel.tsx` | 会话面板用一个**全局 `busy`** 控制发送按钮 `loading`；而 `POST /sessions/:sid/messages` **在服务端会 `await drain(...)`**（见 S31 已记录的语义：整个回合跑完才响应，可能几十秒）。于是给 A 发消息期间按钮一直转圈，**切到 B 也仍是 loading**（antd 按钮 loading 时点击无效）→ B 发不出消息 |
| ② | 同上 | `loadEvents` 无"会话是否已切换"判断：A 的发送在切到 B 后才 `.then`，`setEvents(A 的事件)` 会**覆盖 B 的会话流** |

后端本身是独立的：`drain` 用 `lock.withLock('agent:' + instanceId)`，不同 Agent 之间不互相阻塞（本项目 `agent:pm_1` 与 `agent:dev_1` 各自串行）；问题全在前端把"发送中"当成了全局状态。

## 3 关键决定

1. **"发送中"按会话记**：新增纯函数模块 `web/src/lib/sending.ts` 的 `isSending/withSending/withoutSending`（`readonly string[]` 存会话 id，幂等、不可变），组件里 `const [sending, setSending] = useState<readonly string[]>([])`，`busy = isSending(sending, activeSessionId)`。
2. **发送时先捕获会话 id**：`send()` 一开始就把 `activeSessionId` 存成局部 `sessionId`，后续 `loadEvents/withoutSending` 都用它——用户中途切会话不会把标记清错、也不会加载错会话。
3. **同一会话防重复提交**：`if (busy) return`（busy 已是"当前会话在发送中"）。
4. **迟到的响应不许串会话**：加 `activeSessionRef`（渲染期写入的最新值引用）；`loadEvents` 在 `setEvents` 前判断 `activeSessionRef.current === sessionId`，否则丢弃。
5. **不改后端**：平台"`POST /messages` 等整个回合"的语义与契约保持不变（改它会影响 `queued` 语义与既有用例，见遗留）。

## 4 实现步骤

- 新增 `web/src/lib/sending.ts`（三个纯函数）。
- `web/src/pages/SessionPanel.tsx`：`busy` 改为按会话派生；`send()` 捕获 `sessionId`、`if (busy) return`、`setSending(withSending/withoutSending)`；新增 `activeSessionRef` 并在 `loadEvents` 里做迟到丢弃。
- 测试：新增 `tests/unit/web/sending.test.ts`（5 条）。
- 文档回写：`prd` **D49** + FR-12/FR-29 补注、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s46`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `sending.test.ts` 5 条：只影响被标记会话 / 两会话可同时发送中 / 标记与清除幂等且不改原数组 / 清除一个不影响另一个 / 未选中会话视为"没在发送" |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | ① 给 A 发一条会让它跑很久的消息（`发送` 立刻转圈）→ 马上切到 B：B 的发送按钮**可点、能发出** ② 切回 A 时其按钮仍在转圈（如实反映"这条还在处理中"）③ B 的消息发出后，会话流不会被 A 的事件覆盖 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 同一会话在途时又点发送 | `if (busy) return`（该会话在发送中）；跨会话不受影响 |
| 发送失败后的文字回填 | 保留 S31 逻辑（只有失败才回填，且不覆盖用户新输入） |
| 迟到响应覆盖当前会话 | `activeSessionRef` 判断会话一致才 `setEvents` |
| 用户误以为"没在发送" | 只有活动会话的按钮转圈；底部状态行/输入框上方提示（S42）仍显示该 Agent 的实际状态 |

## 7 遗留

- **平台语义未变**："`POST /sessions/:sid/messages` 要等整个回合跑完才响应"是服务端既有语义（S31 记录在案）。要改成"立刻返回 202、回合在后台跑"，会牵动 `queued` 的判定口径与既有用例（S36/S37 的等待式 POST），属独立一轮。
- **同一会话在途期间不能连发**：现在会直接被 `if (busy) return` 拦掉（原先也只是按钮 loading，行为一致）；若希望"同一会话也能连发排队"，把 `loading` 换成"允许点击但按钮旁给排队提示"即可。
