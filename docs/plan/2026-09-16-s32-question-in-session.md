# S32 方案：询问答复入口归位（会话窗口输入框上方；右栏与任务页只做提示）

> 日期：2026-09-16　类型：交互变更（用户直接指令："询问出现在发送消息窗口的上面，右边列表只提示"）　真源：`design/ui.md` §4/§5、`prd.md` FR-32
> 关联：`docs/changes/2026-09-16-s32-question-in-session.md`、`docs/plan/development.md`

## 1 需求

用户口径：**询问出现在"发送消息窗口"的上面；右边列表只提示。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 会话窗口的**输入框上方**出现「待答复询问（n）」卡 | 只显示**当前会话**（该 Agent）的待答项；有选项的直接点选、无选项的用输入框答 |
| R2 | 答复**原地生效** | 点选项/按「回答」→ 调 `POST /questions/:qid/answer` → 提示"已答复，Agent 将继续"，并刷新会话事件、状态与询问列表 |
| R3 | **右栏询问列表只做提示** | 只显示"谁在问什么 + 答复请到会话窗口"，并提供「到会话里答复」跳转（无回调时退化为纯提示文字） |
| R4 | 「任务与产出物」标签的询问区同样只提示 | 同上口径（用户此前已确认"全部改为只在会话里答复"） |
| R5 | 跳转能落到**对应 Agent 的会话** | 右栏在拓扑页跳：切到「会话」标签并聚焦该实例；右栏在会话页跳：直接选中该会话；任务页跳：同上（复用 S17 的 `sessionFocus`） |
| R6 | 不改后端 | `GET /questions?status=pending`、`POST /questions/:qid/answer` 契约不变 |

## 2 现状与影响面

| 面 | 位置 | 现状（S32 之前） |
| --- | --- | --- |
| 会话窗口 | `web/src/pages/SessionPanel.tsx` | 输入框上方只有「待审批（n）」卡；**没有询问卡**——Agent 提问后用户必须去别处找 |
| 右栏 | `web/src/pages/RightColumn.tsx` | 「询问」列表**自带完整答复界面**（选项按钮/同意）→ 与"只提示"相反 |
| 任务页 | `web/src/pages/WorkPanel.tsx` | 「待答复询问」区也是完整答复界面 |
| 跳转能力 | `TopologyPanel` 已有 `onOpenSession(instanceId)`；`ProjectModule` 已有 `sessionFocus`（S17） | 右栏/任务页没有接上 |
| 后端 | `src/server/http-routes/work.ts`、`application/question/*` | **本轮不改** |

## 3. 关键决定

1. **答复入口唯一化**：只在会话窗口答复。两处能答会让"到底答没答/答了几次"变得含糊（同一个问题在右栏点一次、会话里再点一次）；右栏/任务页改为**提示 + 跳转**，保留"看得见有询问"的能力。
2. **放在输入框上方**（用户指定）：与既有「待审批」卡同一个落点（都在 `Space.Compact` 输入框之前），用户视线在"要发言的地方"就能看到要回答什么——这也符合"先答再发"的实际工作流。
3. **只显示当前会话的待答项**：`question.sessionId === activeSessionId`（S32 之前右栏显示全项目的询问，点开会话才能答；现在按 Agent 切分，避免在 A 的会话里答 B 的问题）。
4. **无选项问题给自由文本**：`ask_user` 的 item 可能没有 `options`，此时给输入框 + 「回答」（`POST` 里传 `text`），而不是像旧右栏那样硬塞一个"同意"按钮（那是错误的语义）。
5. **跳转复用既有能力**：右栏/任务页只回调 `onOpenSession(sessionId)`，由父组件决定"切标签 + 聚焦实例"；会话 id 约定 `u_<instanceId>`，用 `replace(/^u_/, '')` 转实例 id（与会话列表一致）。
6. **不改后端**：接口已经够用（待答列表 + 答复），本轮纯前端。

## 4. 实现步骤

- `SessionPanel.tsx`：新增 `questions` / `answerDrafts` 状态与 `refreshQuestions()`、`answerQuestion()`；WS 里 `question.asked|question.answered` 触发刷新；输入框上方渲染「待答复询问（n）」卡（选项按钮 / 文本输入 + 回答）；右栏传 `onOpenSession` 以支持"跳到本会话"。
- `RightColumn.tsx`：`onOpenSession?: (sessionId: string) => void`；「询问」卡改为提示 + 「到会话里答复」；删除本地 `answer()`。
- `WorkPanel.tsx`：同样加 `onOpenSession?` 并把询问区改为提示 + 跳转；删除本地 `answer()`。
- `TopologyPanel.tsx` / `ProjectModule.tsx`：接上回调（拓扑页转 `instanceId` 后走 `onOpenSession`；任务页设 `sessionFocus` 并切到「会话」）。
- 文档回写：`prd` FR-32 改写 + **D35**、`ui.md` §4/§5、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s32`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`；产物冒烟含 `待答复询问`/`到会话里答复`/`输入你的答复` |
| 回归 | `npm test` 全绿（含验收脚本 7.2「询问阻塞 → 右栏答复后继续」——**该用例走 HTTP 接口，不受前端入口变化影响**）、`npm run coverage`、`npm run ratchet` |
| 活体 | 新产物 200 |
| **用户点验** | 让 Agent 提问后：① 会话窗口输入框上方出现「待答复询问」卡；② 点选项/填文本即答复、Agent 继续；③ 右栏只显示"到会话里答复"按钮 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户在右栏找不到地方答（习惯变化） | 右栏保留完整问题文本 + 显眼跳转按钮；任务页同理 |
| 会话页右栏点"到会话里答复"没反应（已经在该会话） | 会话页的回调就是 `setActiveSessionId(sessionId)`：切到同一会话是幂等的，不会出错 |
| 无选项问题被跳过 | 提供文本输入 + 「回答」按钮；空文本时按钮 disabled |
| 答复后界面不刷新 | 答复成功后同时刷新：询问列表、当前会话事件、Agent 状态（WS 也会推送 `question.answered`） |
