# S33 方案：询问卡改为逐题作答 + 左右滑动

> 日期：2026-09-16　类型：交互变更（用户直接指令："询问方式，一个一个问题回答，卡片左右滑动"）　真源：`design/ui.md` §4、`prd.md` FR-32
> 关联：`docs/changes/2026-09-16-s33-question-carousel.md`、`docs/plan/development.md`

## 1 需求

用户口径：**"询问方式，一个一个问题回答，卡片左右滑动"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **一次只显示一个问题项** | 卡片头部显示 `谁：提问标题` + `第 i/n 题` + `已答 i/n`；正文是该题文本 |
| R2 | **左右滑动切题** | 指针水平拖动 ≥60px 切上一题/下一题；两端夹住（不循环）；同时提供「‹ 上一题 / 下一题 ›」按钮 |
| R3 | **答完自动前进** | 有选项：点按钮即作答并自动到下一题；无选项：输入框回车或点「作答」同上 |
| R4 | **攒齐后一次提交** | 「提交答复」按钮在**必答题全部作答**后才可用；提交走一次 `POST /questions/:qid/answer`（**不能逐题提交**，见 §3-1） |
| R5 | 已有能力不回退 | 仍放在会话窗口输入框上方（S32）、右栏与任务页仍只提示、答复后刷新询问列表/会话事件/状态 |

## 2 现状与影响面

| 面 | 位置 | 现状（S32 之后） |
| --- | --- | --- |
| 会话窗口 | `web/src/pages/SessionPanel.tsx` | 「待答复询问」卡把 `question.items`（`ask_user` 一次最多 6 项）**全部竖排**展示，每项各自带按钮/输入框 —— 问题一多就是一屏，且**每题点一下就会各自 POST 一次** |
| 后端语义 | `src/application/question/question-service.ts:96` | `answer()` 校验必答项 → 写盘 → **立即唤醒提问的 Agent**（`waiters` 解析 + 通知 asker + 广播 `question.answered`） |
| 纯逻辑 | — | 逐题作答的"游标/必答校验/提交负载"目前没有可单测的落点 |

## 3 关键决定

1. **必须攒齐后一次提交**（本轮最重要的约束）：后端 `answer()` 一被调用就**立刻唤醒 Agent**。若沿用"每题各自 POST"，用户点第一个选项时 Agent 就带着半份答复继续跑了（其余问题还会被当成"未答复"）。因此 UI 在本地收集全部答复，最后一次提交。
2. **一题一卡（carousel）而不是"逐题弹窗"**：卡片留在会话窗口（不打断阅读），游标在本地；配合 `第 i/n 题` 与 `已答 i/n` 让进度可见。
3. **滑动 + 按钮双通道**：桌面主要用按钮（可发现性），移动端/触控用滑动；滑动阈值 60px，两端夹住不循环（避免"滑到头又跳回第一题"的困惑）。
4. **滑动用 pointer 事件，且按在按钮上不启动拖拽**：这是 S17 指针捕获事故的教训（捕获会把 `click` 从卡片内按钮上抢走）；同时 `touchAction: 'pan-y'` 保留纵向滚动。
5. **逻辑抽成纯函数**（`web/src/lib/question-wizard.ts`）：游标夹取、必答校验、提交负载构造都能被 node 侧单测覆盖（延续 S23/S26/S28/S30 的做法）。
6. **只改前端**：接口契约不变。

## 4 实现步骤

- `web/src/lib/question-wizard.ts`（新增，纯函数）：`withAnswer` / `answeredCount` / `canSubmit` / `missingRequired` / `stepCursor` / `swipeDirection` / `toAnswerPayload`。
- `web/src/components/QuestionCarousel.tsx`（新增）：单题卡片 + 游标 + 本地答复表 + pointer 滑动 + 「上一题/下一题/提交答复」；提交回调由父组件注入。
- `web/src/pages/SessionPanel.tsx`：`answerQuestion(question, answers[])` 改为**一次提交多题**；用 `<QuestionCarousel>` 替换逐项竖排渲染；删除已不需要的 `answerDrafts` 状态。
- `tests/unit/web/question-wizard.test.ts`（新增 6 条）：记账/覆盖、已答计数与必答校验、缺答点名、游标夹取、滑动方向、提交负载。
- 文档回写：`prd` **D36** + FR-32 补注、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s33`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/web/`（event-display 9 + question-wizard 6） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| 产物冒烟 | 产物含 `上一题`/`下一题`/`提交答复`/`卡片可左右滑动切题` |
| 活体 | 新产物 200 |
| **用户点验** | Agent 提多个问题时：① 一次只显示一题；② 左右拖动或点箭头切题；③ 答完必答题后「提交答复」可用；④ 点一次提交即答复全部（Agent 只被唤醒一次） |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 拖动误触按钮/输入框 | `pointerdown` 时若目标是 `button` 则完全不启动拖拽；输入框在无选项题里，拖动从卡片空白处开始 |
| 触屏上滑动与页面滚动冲突 | `touchAction: 'pan-y'`（只让卡片接管横向手势） |
| 用户漏答必答题却点提交 | 按钮 disabled + 文案「答完全部必答题后可提交」；`canSubmit` 有两道（前端禁用 + 后端校验 `ERR_VALIDATION`） |
| 重新作答（改答案） | 同题再点即覆盖本地草稿；按钮高亮显示当前选择；已答题目标记"已答，可重新选择" |
| 多条提问同时存在 | 每条提问渲染一个独立 carousel（`key=question.id`），游标互不干扰；实际上一 Agent 同时至多 1 个待答（服务端约束） |
