# S42 方案：输入框上方的「现在在干什么」等待提示

> 日期：2026-09-16　类型：用户口径（"对话框里需要有个等待交互，让用户知道现在正在调用工具，还是模型"）　真源：`design/ui.md` §4、`api/contract.md` §3、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s42-composer-status.md`、`docs/plan/development.md`

## 1 需求

用户口径：**对话框（输入区）里要有个等待交互，让用户知道"现在是在调用工具，还是在跑模型"。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 输入框上方有一句话**说明当前动作** | 分得清：`正在调用工具 <名>…` / `模型正在输出…` / `模型正在思考…` / `等待你的答复` / `等待你的审批` / `已暂停…` / `排队 N 条` |
| R2 | 该转圈的才转圈 | 只有"正在跑"（工具/模型）转圈；等待用户、暂停、排队不转 |
| R3 | 空闲时不占版面 | 空闲且无排队 → **不渲染**（延续 S15/S19 的"没内容就不占位"口径） |
| R4 | 语气可辨 | 等待答复用 warning 色（要用户动手），其余次要色 |
| R5 | 底部状态行口径统一 | 原来的 `状态：working`（原始英文值）改用 S38 的状态文案（`工作中`/`等待回复中`/…） |
| R6 | 不改后端 | 复用既有信号：`GET /agents` 状态投影 + 会话事件 + WS `message.chunk`（平台本来就推，此前前端无人消费） |

## 2 现状与根因

| 位置 | 现状 |
| --- | --- |
| `web/src/pages/SessionPanel.tsx` | 输入框上方只有**询问卡/审批卡**；会话流底部一行 `状态：working｜排队 0 条｜会话进度 #12`——原始英文状态、不显眼，也**分不清"在调工具"还是"在生成"** |
| WS `message.chunk` | 平台从 S4 起就在推流式增量（`{sessionId, turnId, seq, delta}`），**前端从未消费** → "模型正在输出"这一层信号被白白丢掉 |
| 事件流 | `tool_call` 与 `tool_result` 按 `callId` 配对，可判定"某工具正在执行中" |

## 3 关键决定

1. **合成一句话，而不是堆信号**：新增纯函数 `composerStatus({ status, events, streaming, hasPendingQuestion })`，把三类信号合成 `{ text, tone, spinner }`：
   - 状态投影：`paused` → 已暂停；`waiting`+`waitingFor` → 等答复/等审批；`working` → 在跑；`queued` → 排队；
   - 事件尾巴：用 `openToolCall(events)` 找"已发起、无结果"的 `tool_call` → `正在调用工具 <名>…`；
   - 流式增量：`message.chunk` 在来 → `模型正在输出…`；否则 `模型正在思考…`（最保守、也最诚实：没有增量时不能假装在输出）。
2. **不新增后端字段/帧**：`message.chunk` 与 `agent.state` 都已存在，本轮只补前端消费。
3. **空闲不渲染**：与 S15「运行细条空闲不渲染」、S19「列表只留名称+状态」同口径，避免常驻噪音。
4. **文案优先级**：暂停 > 等待用户 > 正在跑 > 排队。暂停是"用户自己按的"，等待用户是"要用户动手"，都优先于过程信息。
5. **纯函数先行**：`composer-status.ts` 可在 node 侧单测，组件只做映射（延续 S26/S28/S33/S35/S37/S38/S39/S41）。
6. **顺手统一底部状态行**：`activeStatus.state` 原始值 → `agentState(activeStatus).text`（S38 的「工作中/等待回复中/已暂停」）。

## 4 实现步骤

- 新增 `web/src/lib/composer-status.ts`：`openToolCall(events)` + `composerStatus(input)`。
- `web/src/pages/SessionPanel.tsx`：新增 `streaming` 状态（`message.chunk` → true；本会话 `event.appended` → false；切会话 → false）；`composer` 用 useMemo 合成；输入框上方渲染 `Spin` + 文案（waiting 用 warning）；底部状态行改用 `agentState(...)`。
- 测试：新增 `tests/unit/web/composer-status.test.ts`（8 条：空闲不渲染 / 调工具 / 工具已结束 → 思考 / 流式输出 / 等答复 / 等审批 / 暂停 / 排队 + `openToolCall` 三条边界）。
- 文档回写：`prd` **D45** + FR-30 补注、`ui.md` §4、`contract.md`（`message.chunk` 的消费方说明）、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s42`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `composer-status.test.ts` 8 条；含 `openToolCall` 的"未闭合才算正在调用""`turn_end`/`message` 之后旧调用不算""多工具只看最后一次未闭合" |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | ① 让 Agent 干活：输入框上方应依次出现「模型正在思考…」→「正在调用工具 X…」→「模型正在输出…」② 需要决策时会显示「等待你的答复」③ 空闲时不显示任何等待提示 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 文案与实际不符（例如显示"正在输出"其实模型卡住了） | 只有收到 `message.chunk` 才说"正在输出"，否则一律"正在思考"（保守说） |
| 流式增量被误判为"还在跑"（增量停了但没事件） | 任一 `event.appended`（落盘）即把 streaming 复位；切会话也复位 |
| 多会话并发时串台 | `message.chunk` 帧带 `sessionId`，只认当前会话；切会话重置 |
| 文案膨胀、占版面 | 只有"非空闲"才渲染；一行 12px 次要文字 + 小转圈 |
