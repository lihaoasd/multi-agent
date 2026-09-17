# 修改记录 · S32 询问答复入口归位（会话窗口输入框上方；右栏/任务页只提示）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s32-question-in-session.md](../plan/2026-09-16-s32-question-in-session.md)
> 关联设计：[ui.md](../design/ui.md) §4/§5、[prd](../requirements/prd.md) FR-32 / D35

## 1. 需求 / 问题

用户口径：**"询问出现在发送消息窗口的上面，右边列表只提示"**。

S32 之前：会话窗口里**没有询问卡**（Agent 提问后用户得去右栏或「任务与产出物」标签找），而右栏与任务页**各自带一套完整答复界面** —— 与实际工作流相反：用户在会话里看到 Agent 在等，却必须切到别处回答。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/SessionPanel.tsx` | 新增 `questions`/`answerDrafts` 状态、`refreshQuestions()`、`answerQuestion()`（支持 `choice` 与自由 `text`）；WS 的 `question.asked`/`question.answered` 触发刷新；**在输入框（`Space.Compact`）上方**渲染「待答复询问（n）」卡：有选项→按钮直接点选，无选项→输入框 + 「回答」；只显示当前会话的待答项（`question.sessionId === activeSessionId`）；右栏传 `onOpenSession`（会话页内即选中该会话） |
| web | `web/src/pages/RightColumn.tsx` | 新增可选 `onOpenSession?: (sessionId: string) => void`；「询问」卡**降级为提示**：显示 `asker：title` + "答复请到会话窗口（输入框上方）" + 「到会话里答复」（无回调时只有提示文字）；删除本地 `answer()` |
| web | `web/src/pages/WorkPanel.tsx` | 同样新增 `onOpenSession?`，「待答复询问」区降级为提示 + 跳转；删除本地 `answer()` |
| web | `web/src/pages/TopologyPanel.tsx` | 给 `RightColumn` 接上回调：`sessionId.replace(/^u_/, '')` → 既有的 `onOpenSession(instanceId)`（切到会话标签并聚焦该实例） |
| web | `web/src/pages/ProjectModule.tsx` | 给 `WorkPanel` 接上回调：设 `sessionFocus`（S17 的聚焦令牌）并切到「会话」标签 |
| docs | `prd`（FR-32 改写 + **D35**）、`ui.md` §4/§5、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：后端（`GET /questions?status=pending`、`POST /questions/:qid/answer` 契约不变）；`ask_user` 工具与询问落盘逻辑；审批卡的答复入口（仍在会话窗口内，位置未动）。

## 3. 关键决定

1. **答复入口唯一化到会话窗口**：两处都能答会让"答没答、答几次"含糊；右栏/任务页保留"看得见 + 一键跳过去"。
2. **落在输入框上方**（用户指定）：与既有「待审批」卡同一落点，用户视线在发言处即可看到要回答什么。
3. **只显示当前会话的待答项**：避免在 A 的会话里答 B 的问题（右栏仍可看全项目的询问条数并跳转）。
4. **无选项问题给自由文本**：`ask_user` 的 item 可能没有 `options`，旧界面在这种情况下硬塞「同意」按钮（语义错误）；现在给输入框 + 「回答」，空文本时按钮禁用。
5. **跳转复用既有能力**：`u_<instanceId>` → `instanceId` 后走 S17 的 `onOpenSession`/`sessionFocus`，不新增导航机制。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 全量测试 | `npm test` **49 files / 326 tests 全绿**（含验收脚本 7.2「询问阻塞 → 答复后继续」；该用例走 **HTTP 接口**，不受前端入口变化影响） |
| 覆盖率门禁 | `npm run coverage` 142/142；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BvYi7Mli.js`（1,358.61 kB / gzip 425.30 kB），冒烟含 `待答复询问`、`到会话里答复`、`输入你的答复`；活体 200 |
| **未覆盖** | 无 DOM 测试：需用户点验 ① 会话窗口输入框上方出现询问卡 ② 点选项/填文本即答复且 Agent 继续 ③ 右栏只有"到会话里答复"跳转 ④ 任务页同样只提示 |
| 说明 | 与 S4/S7/S12/S15~S31 的交付口径一致 |

## 5. 遗留

- 询问卡只显示**待答**项：已答记录仍只在会话事件流（`question` 相关事件）与 API 里可见；若要在会话窗口保留"已答过什么"的回执卡片，属新需求（当前 Agent 自己会在正文里复述）。
- 「到会话里答复」只切到会话标签 + 聚焦实例，**不会自动滚动到询问卡**（卡片固定在输入框上方，无需滚动）——如果以后会话流变长、卡片位置变化，需要再补滚动定位。
- 会话页右栏与拓扑页右栏都显示"询问（n）"，但**条数是全项目的**；若希望只显示当前会话的，可在会话页传入过滤（当前刻意保持两处一致）。
- 前端仍无 DOM/组件测试：本轮的"卡片是否挂在正确位置"只能靠点验（同类问题在 S23/S27/S28/S29/S31 已多次记录，DOM 测试环境仍建议单独立项）。
