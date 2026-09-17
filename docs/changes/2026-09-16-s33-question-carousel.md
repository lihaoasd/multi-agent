# 修改记录 · S33 询问卡改为逐题作答 + 左右滑动

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s33-question-carousel.md](../plan/2026-09-16-s33-question-carousel.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-32 / D36

## 1. 需求 / 问题

用户口径：**"询问方式，一个一个问题回答，卡片左右滑动"**。

S32 之后的卡片把 `ask_user` 的全部问题项（一次最多 6 项）**竖排铺开**，每项各自带按钮/输入框 —— 问题一多就是一屏；而且**每题点一下就会各自 POST 一次**，这与后端语义冲突（见 §3-1）。

## 2. 改动范围（仅前端 + 文档 + 测试）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web（新增） | `web/src/lib/question-wizard.ts` | 纯函数：`withAnswer`（记/覆盖草稿）、`answeredCount`、`canSubmit`（必答题全答才可提交）、`missingRequired`、`stepCursor`（两端夹住不循环）、`swipeDirection`（±60px 阈值）、`toAnswerPayload`（只带有作答的题） |
| web（新增） | `web/src/components/QuestionCarousel.tsx` | 单题卡片：头部 `谁：标题` + `第 i/n 题` + `已答 i/n` + 「已答，可重新选择」；正文题目文本；有选项点按钮、无选项输入框回车/「作答」；答完**自动前进**；「‹ 上一题 / 下一题 ›」+ **pointer 左右滑动切题**（`touchAction: 'pan-y'`，按在按钮上不启动拖拽——S17 教训）；「提交答复」在必答题全答后可用 |
| web | `web/src/pages/SessionPanel.tsx` | `answerQuestion(question, answers[])` 改为**一次提交多题**（单次 POST）；用 `<QuestionCarousel>` 替换逐项竖排；移除不再需要的 `answerDrafts` 状态 |
| tests（新增） | `tests/unit/web/question-wizard.test.ts` | 6 条：草稿记账与覆盖、已答计数与必答校验、缺答点名、游标夹取（含空列表）、滑动方向阈值、提交负载只带已答项 |
| docs | `prd`（**D36** + FR-32 补注）、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：后端与接口（`POST /questions/:qid/answer` 契约不变）；右栏与任务页的"只提示"口径（S32）；审批卡。

## 3. 关键决定

1. **必须"攒齐后一次提交"**（本轮最重要的约束）：`src/application/question/question-service.ts` 的 `answer()` 一被调用就**立刻唤醒提问的 Agent**（解析 waiter + 通知 + 广播）。若逐题 POST，用户答第一题时 Agent 就带着半份答复继续跑了。因此 UI 在本地收集全部答复，最后一次提交。
2. **一题一卡（carousel）而不是逐题弹窗**：卡片留在会话窗口不打断阅读；`第 i/n 题` 与 `已答 i/n` 让进度可见。
3. **滑动 + 按钮双通道**：桌面用按钮（可发现性）、触控用滑动；阈值 60px、两端夹住不循环。
4. **滑动用 pointer 事件并避开按钮**：`pointerdown` 目标是 `button` 时完全不启动拖拽（S17 的指针捕获事故教训：捕获会把 `click` 从卡片内按钮上抢走）；`touchAction: 'pan-y'` 保留纵向滚动。
5. **逻辑抽纯函数**：游标/校验/负载构造都能被 node 侧单测覆盖（延续 S23/S26/S28/S30）。
6. **重答友好**：同题再点即覆盖草稿，按钮高亮当前选择，头部提示"已答，可重新选择"。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 前端单测 | `tests/unit/web/` **15 passed**（event-display 9 + question-wizard 6） |
| 全量测试 | `npm test` **50 files / 332 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` 142/142；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-B8zmHUtu.js`（1,360.55 kB / gzip 426.09 kB），冒烟含 `上一题`/`下一题`/`提交答复`/`卡片可左右滑动切题`；活体 200 |
| **未覆盖** | 无 DOM 测试：需用户点验 ① 一次只显示一题 ② 左右拖动/按钮切题 ③ 答完必答题才可提交 ④ 提交一次即答复全部（Agent 只被唤醒一次） |
| 说明 | 与 S4/S7/S12/S15~S32 的交付口径一致 |

## 5. 遗留

- 滑动的**手势体验**只在浏览器实机验证（无自动化）：`touchAction: 'pan-y'` + 60px 阈值是常见折中，若移动端觉得迟钝/过敏，调 `SWIPE_THRESHOLD` 即可。
- 卡片**不做动画转场**（只做 `translateX` 跟手与 120ms 回弹），若想要"卡片堆叠滑动"的视觉效果，需要额外的过渡层（属视觉增强）。
- 多条提问时每条各渲染一个 carousel：服务端限制"同一 Agent 至多 1 个待答"，因此正常只会看到一条；若未来放开限制，需要跨提问的"整体进度"设计。
- 已答记录仍只体现在会话事件流（S32 遗留），卡片提交后即消失。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32 记录）。
