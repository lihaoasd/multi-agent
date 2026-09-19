# 修改记录 · S42 输入框上方的「现在在干什么」等待提示

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s42-composer-status.md](../plan/2026-09-16-s42-composer-status.md)
> 关联设计：[ui.md](../design/ui.md) §4、[contract.md](../api/contract.md) §3、[prd](../requirements/prd.md) FR-30 / D45

## 1. 需求 / 问题

用户口径：**"对话框里需要有个等待交互，让用户知道现在正在调用工具，还是模型。"**

现状：输入框上方只有询问卡/审批卡；底部一行 `状态：working｜排队 0 条｜会话进度 #12` —— **原始英文状态**、不显眼，而且**分不清"在调工具"还是"在跑模型"**。另外，平台从 S4 起就在 WS 推流式增量 `message.chunk`，**前端从未消费**，"模型正在输出"这层信号被白白丢掉。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/lib/composer-status.ts`（新） | 纯函数 `openToolCall(events)`（找"已发起、无结果"的工具调用）+ `composerStatus({status, events, streaming, hasPendingQuestion}) → { text, tone, spinner } \| null` |
| web | `web/src/pages/SessionPanel.tsx` | 新增 `streaming`（订阅 `message.chunk`：本会话增量 → true；本会话 `event.appended` → false；切会话 → false）；`composer` useMemo 合成；**输入框上方**渲染 `Spin` + 文案（等待答复用 warning 色）；底部状态行改用 S38 的 `agentState(...).text`（不再是原始 `working`） |
| tests | `tests/unit/web/composer-status.test.ts`（新 8） | 见 §4 |
| docs | `prd`（**D45** + FR-30 补注）、`ui.md` §4、`contract.md` §3（`message.chunk` 消费方）、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s42` | 全链路回写 |

**未改**：后端与接口（复用既有 `GET /agents` 投影、会话事件、`message.chunk` 帧）；询问卡/审批卡的落点与交互（S32/S33）；会话流条目口径（S22/S26/S28/S34/S41）。

## 3. 关键决定

1. **三类信号合成一句话**（优先级：暂停 > 等待用户 > 正在跑 > 排队）：
   | 条件 | 文案 | 转圈 |
   | --- | --- | --- |
   | `paused` | `已暂停：不再领新活（恢复后继续处理队列）` | 否 |
   | `waitingFor=question`（或本会话有待答询问） | `等待你的答复（在下方答复卡里作答）` | 否（warning 色） |
   | `waitingFor=approval` | `等待你的审批` | 否（warning 色） |
   | `working` 且存在未闭合 `tool_call` | `正在调用工具 <名>…` | 是 |
   | `working` 且正在收流式增量 | `模型正在输出…` | 是 |
   | `working` 其它 | `模型正在思考…` | 是 |
   | 空闲且 `queued>0` | `排队 N 条，稍后处理` | 否 |
   | 空闲且无排队 | **不渲染** | — |
2. **"正在输出"必须有增量才敢说**：只有收到 `message.chunk` 才显示；否则一律"模型正在思考…"——宁可保守，也不假装在输出。
3. **不新增后端字段/帧**：`message.chunk` 平台早已在推（contract.md §3），本轮补前端消费；这也为后续"边流边看"留了口子（未做，见遗留）。
4. **空闲不占版面**：延续 S15「运行细条空闲不渲染」、S19「列表只留名称+状态」的口径。
5. **顺手统一底部状态行**：`状态：working` → `状态：工作中`（等待时是「等待回复中」，S38 同源）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 新增单测 | `tests/unit/web/composer-status.test.ts` **8 passed**：空闲不渲染 / 调工具（带工具名 + 转圈）/ 工具已结束 → 思考（无增量）与输出（有增量）/ 等答复（含"投影缺 `waitingFor` 但本会话有询问"兜底）/ 等审批 / 暂停 / 排队；`openToolCall` 三条边界（未闭合才算、`turn_end`/`message` 之后不算、多工具只看最后一次未闭合） |
| 全量测试 | `npm test` **59 files / 376 tests 全绿**（S41 基线 58 / 368） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-CjTp_u1L.js`（1,376.24 kB / gzip 430.85 kB，+0.39 kB gzip） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— ① 让 Agent 干活，输入框上方依次出现「模型正在思考…」→「正在调用工具 X…」→「模型正在输出…」② 需要决策时显示「等待你的答复」③ 空闲时不显示 |
| 说明 | 与 S15~S41 的交付口径一致 |

## 5. 遗留

- **没有"边流边看"**：虽然已经在消费 `message.chunk`，但只用于状态判定，**没有把增量文本渲染成一枚"正在生成"的气泡**（那需要处理落盘后的替换、Markdown 渲染与去重）。若要 ChatGPT 式实时打字，见 `contract.md` §3 的 `message.chunk`（每次增量带 `seq`/`delta`）。
- **"思考中"与"生成中"的区分是近似的**：`thought` 事件在**模型调用结束后**才落盘，所以增量到达之前只能统一说"模型正在思考…"；真正的"正在思考"需要适配器把 `reasoning-delta` 也推成帧（当前只推 `text-delta`）。
- **排队数只在非工作态提示**：正在工作时若队列还有消息，提示语仍是"正在调用工具…"（排队数在底部状态行可见）。
- **等待审批未做"就地批准"**：提示语指向审批卡（`待审批（n）`），入口不变。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36/S37/S38/S39/S40/S41 记录）。
