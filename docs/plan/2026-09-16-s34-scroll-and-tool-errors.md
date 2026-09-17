# S34 方案：会话窗口高度铺满 + 自动跟随最后一条消息；工具报错显示报错内容

> 日期：2026-09-16　类型：两点用户指令（1. 聊天窗口高度对应屏幕、保持跟踪最后一个消息；2. 工具报错需要显示报错内容）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s34-scroll-and-tool-errors.md`、`docs/plan/development.md`

## 1 需求

| # | 用户口径 | 验收 |
| --- | --- | --- |
| R1 | **聊天窗口高度与屏幕对应** | 会话卡片占满视口剩余高度（`calc(100vh - 270px)`，下限 360px），消息区 `flex:1` 撑满卡片，输入框与状态行**钉在底部** |
| R2 | **保持跟踪最后一条消息** | 新消息/事件（含流式增量触发的重渲染）到达时自动滚到底部；**用户手动上翻时不打扰**（距底 > 40px 视为"在看历史"），一旦回到底部附近自动恢复跟随 |
| R3 | **工具报错要显示报错内容** | `tool_result` 且 `ok=false` 时，条目显示**报错文本**（如 `[ERR_FORBIDDEN] 归属校验失败：…`）并整行标红；成功时仍**只显示工具名**（S26 口径不变） |
| R4 | 其余不变 | 消息 Markdown、思考/工具调用（参数默认折叠）、错误事件、询问卡/审批卡位置均不受影响 |

## 2 现状与影响面

| 面 | 位置 | 现状（S33 之后） |
| --- | --- | --- |
| 会话窗口高度 | `web/src/pages/SessionPanel.tsx` | 消息区 `maxHeight: calc(100vh - 350px)` + `minHeight: 300`（S20）——高度靠"估算偏移"，卡片本身不参与撑满，屏幕变矮/变高时余量不精确 |
| 滚动跟随 | 同上 | **完全没有**：新事件追加在下面，用户必须手动往下滚（Agent 连续输出工具调用/思考时尤其明显） |
| 工具报错 | `web/src/lib/event-display.ts` | `eventRow` 对 `tool_result` 一律 `body: null`（S26"只显示工具名"），失败仅靠**红色**表达 → 用户知道"错了"但**不知道错在哪** |
| 后端 | — | **本轮不改**（`tool_result.payload.summary` 里本来就带 `[CODE] message`，只是前端没显示） |

## 3 关键决定

1. **高度用 flex 撑满而不是继续调 `calc`**：卡片固定为 `calc(100vh - 270px)` 的**纵向 flex 容器**（`styles.body` 里 `display:flex; flexDirection:column; flex:1; minHeight:0`），消息区 `flex:1`，输入框自然钉底。这样"屏幕多高、消息区就多高"，也不再依赖"猜上方元素总高"（S20 的 350 是一个手算常数）。
   - 保留 `minHeight: 360`（卡片）与消息区 `minHeight: 200`：窗口很矮时宁可整页滚动，也不把消息区压没。
2. **跟随策略：默认跟住 + 尊重用户上翻**（阈值 40px）：这是聊天界面的通行做法——自动滚到底但**不与用户抢滚动条**。判定用 `scrollHeight - scrollTop - clientHeight < 40`，在 `onScroll` 里更新一个 `stickToBottom` 状态；`useEffect` 依赖 `visibleEvents`（新事件到达即跟随）。
3. **R3 与 S26 不冲突**：S26 的口径是"**成功**时不要噪音"；S34 补的是"**失败**时必须给出原因"。两者合并后的规则：`工具结果 = 成功→只有工具名；失败→工具名 + 报错正文（整行标红）`。
4. **报错正文用 `summary`**：生产者（`agent-loop/strategies.ts`）在失败时写入 `[${error.code}] ${error.message}`，正好是用户需要的信息；无需后端改动。
5. **逻辑仍放在 `eventRow` 里**：R3 是"一行怎么渲染"的规则，放进既有纯函数即可被单测覆盖（延续 S26/S28 的做法）。

## 4 实现步骤

- `web/src/pages/SessionPanel.tsx`
  - 会话卡片：`style={{ flex: 1, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 270px)', minHeight: 360 }}` + `styles={{ body: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } }}`。
  - 消息区：`ref={scrollRef}` + `onScroll={onScroll}` + `style={{ flex: 1, minHeight: 200, overflowY: 'auto', paddingRight: 8 }}`（去掉 `maxHeight`）。
  - 新增 `scrollRef`、`stickToBottom` 状态与 `onScroll`；`useEffect([visibleEvents, stickToBottom])` 在跟随状态下把 `scrollTop` 拉到底。
- `web/src/lib/event-display.ts`：`eventRow` 的 `tool_result` 分支——失败时 `body = eventBody(event)`、`bodyMode = 'inline'`（正文为空则回退 `none`）；成功维持 `body: null`。同步更新 `EventRow` 注释与文件头"一行怎么渲染"的说明。
- `tests/unit/web/event-display.test.ts`：把"工具结果"用例改为**成功只显示名字 / 失败显示报错内容**。
- 文档回写：`prd` **D37** + FR-30 补注、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s34`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/web/`（event-display 9 + question-wizard 6） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| 活体 | 新产物 200 |
| **用户点验** | ① 会话窗口高度跟着屏幕（不空一大块、也不被截断），输入框在底部；② Agent 连续输出时**自动跟到最新**，手动上翻时不被打断、回到底部后恢复跟随；③ 让工具报错（如越界读文件），该行显示**报错文本** |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| `calc(100vh - 270px)` 偏移估算偏差 | 只影响"多一点/少一点"，且有 `minHeight` 兜底；若实测偏差明显，调整该常数即可（一处） |
| 自动滚动打断用户阅读历史 | 40px 阈值 + `stickToBottom` 判定；只有贴底时才跟随 |
| 报错正文很长刷屏 | 失败正文来自 `tool_result.summary`（生产者已截断到 ≤2000 字符），且整行仍受 `maxWidth: 85%` 约束 |
| 与"工具结果只显示名字"的口径冲突 | 已在 `ui.md` 与 prd D37 写明合并规则：**成功=只有名字，失败=名字+报错正文** |
