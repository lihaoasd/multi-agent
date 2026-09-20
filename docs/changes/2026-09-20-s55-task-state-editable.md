# 修改记录 · S55 「任务与产出物」里任务状态可改

> 类别：changes · 日期：2026-09-20 · 关联方案：[docs/plan/2026-09-20-s55-task-state-editable.md](../plan/2026-09-20-s55-task-state-editable.md)
> 关联设计：[data-storage.md](../design/data-storage.md) §7、[agent-runtime.md](../design/agent-runtime.md) §6、[ui.md](../design/ui.md) §5、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-08 / D59

## 1. 需求 / 问题

用户报告：**"任务与产出物里任务状态是不能修改的"**。

面板上确实有状态下拉，但能改成功的场景很窄，而且**改完角色也不动**：

| # | 代码级原因 | 用户感受 |
| --- | --- | --- |
| ① | `setState` 只允许 `todo → in_progress`（`if (state==='in_progress' && task.state!=='todo') return ERR_CONFLICT`） | 把**已完成/已终止**的任务重新开工（很自然的动作）只会得到报错。该限制本是给 Agent 的 `claim` 用的，不该管用户 |
| ② | 该角色已有进行中的任务 → `ERR_CONFLICT`（`detail.holding`），界面没有出路 | 用户项目里 qa_1/architect_1/dev_1/ui_1 **各自都有一条进行中任务** ⇒ "把某条活开工"**必然失败** |
| ③ | 下拉包含当前状态 | 选它 → 「任务已是 X 状态」，什么都没改却报错 |
| ④ | 历史 `blocked` 行的 `value` 不在 `options` 里 → antd 回退显示原始值 `blocked` | 看到英文值，像是"改不了" |
| ⑤ | **`in_progress` 路径从不通知受派人**（只在 `done/terminated` 通知委派人、`create` 通知「待领取」） | 状态改了，角色不知道要开工——而 `agent-runtime.md` §6 / `orchestration.md` §5 早写着「**激活即唤醒**：任务置 `in_progress` 时向受派者注入唤醒消息」 |
| ⑥ | 失败反馈只进面板顶部 `Alert` | 表格长时以为"点了没反应" |

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| application | `src/application/task/task-service.ts` | `setState`：`todo` 前置**只对 `actor !== 'user'` 生效**（老板可从 `done`/`terminated`/`blocked` 直接重新开工；Agent 仍须 `claim`）；槽位冲突文案改为「先把它标为已完成或已终止，再开工这条」并补 `detail.holdingTitle`；**激活即唤醒**——置 `in_progress` 且 `actor !== assignee` 时经 `notify` 通知受派人（系统消息 + 唤醒一轮），失败只 `warn` 不阻断 |
| web | `web/src/lib/task-state.ts`（新） | `SELECTABLE_TASK_STATES`、`taskStateOptions(current, labels)`（排除当前状态；历史状态补禁用占位项以显示中文名）、`holdingTaskOf(detail)` |
| web | `web/src/pages/WorkPanel.tsx` | 任务表操作列：`taskStateOptions(...)` 作为选项；`changeTaskState`（终止前 `Modal.confirm`，说明会先结算未结算改动）→ `applyTaskState`（成功后 `message.success`，失败 `message.error`；命中槽位冲突时 `Modal.confirm`"收口它并开工"，按顺序两步调用同一接口） |
| tests | `tests/unit/application/task-question-service.test.ts`（+2）、`tests/unit/web/task-state.test.ts`（新 4）、`tests/integration/server/work-api.test.ts`（规则 15/24 扩展 3 组断言） | 见 §4 |
| docs | `prd`（**D59** + FR-08 补注）、`data-storage.md` §7、`agent-runtime.md` §6、`ui.md` §5（含修正右栏任务列表"可执行操作"与实现不符的表述）、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s55` | 全链路回写 |

**未改**：`blocked` 仍不接受新迁移（S53/D57）；单工槽位规则本身；`claim` 的 `todo` 前置；`done`/`terminated` 的结算与"通知委派人继续"；任务标题/说明/受派人在面板上仍不可编辑（本轮只解决状态）。

## 3. 关键决定

1. **"谁能改"要分清**：`todo → claim → in_progress` 是**角色的**纪律（防绕过排队）；老板在面板上直接改是**管理动作**，不该被同一条限制挡住——所以限制加 `actor !== 'user'` 的条件，而不是整体放开（Agent 侧口径不变，集成测试同时钉住两端）。
2. **单工槽位不放宽，但必须给出路**：`activeFor`、任务上下文注入、会话顶部「正在执行」、`/agents.currentTask` 都以"每角色至多一个 `in_progress`"为前提，放宽会连带一堆语义。所以冲突时返回 `holding`/`holdingTitle`，面板把"先收口旧的再开工新的"做成**一次确认**（两步 PATCH）。
3. **激活就要真的开工**：文档早就承诺「激活即唤醒」，实现却漏在 `setState` 这条路径上——这正是"改了状态没反应"的根源。补齐方式沿用组合根既有的 `notify`（系统消息进受派人 user 会话 + 排一次 drain），与派单通知同源。
4. **下拉不再提供"当前状态"**：选了只会换来一句报错，是"不能修改"观感的一部分；历史 `blocked` 则用**禁用占位项**换取正确的中文显示。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 新增单测（服务） | `task-question-service.test.ts` **+2 passed**：① `actor='user'` 可从 `todo` 直接置 `in_progress`，`done → in_progress` 可重开，且**受派人收到"置为进行中"通知**；`actor='dev_1'` 走同一动作仍 `ERR_CONFLICT` ② 槽位冲突返回 `ERR_CONFLICT` + `holding`/`holdingTitle` + 文案「先把它标为已完成或已终止」，随后"先收口再开工"两步调用都成功 |
| 新增单测（前端纯逻辑） | `tests/unit/web/task-state.test.ts` **4 passed**：可选集合不含 `blocked`；**每个状态下拉都排除自身**且长度 = 4−1、无禁用项；`blocked` 行首项为禁用占位（`受阻（旧数据）`）；`holdingTaskOf` 的正常/兜底/非法输入 |
| 集成（HTTP） | `work-api.test.ts` 规则 15/24 扩展：缺省 actor（＝user）把 `done` 任务改回 `in_progress` → **200**，且 `u_dev_1` 会话里出现「置为进行中」系统消息；同一动作带 `actor:'dev_1'` → **409** |
| 全量测试 | `npm test` **68 files / 426 tests 全绿**（S54 后为 67/420） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| typecheck / eslint | 0 错误（src + web） |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-CHlHI_kN.js`（1,382.85 kB / gzip 433.02 kB） |
| **活体验证**（运行中的实例；用**临时项目**验完即删，不动用户既有项目） | 建临时项目 → 派单 `todo` → 缺省 actor 置 `in_progress` **200** → 置 `done` **200** → **再置 `in_progress` 200（S55 之前必 409）** → 受派人会话出现「置为进行中」系统消息 → 同动作 `actor=dev_1` **409** → 删除临时项目（项目列表恢复为只剩「贪吃蛇」） |
| **未覆盖** | 面板交互（选项/确认框/提示）无法在本机自动化：**须用户点验** —— 下拉里没有当前状态；把已完成/已终止的任务改成「进行中」直接成功；该角色有别的活时先问"收口它并开工"；「受阻（旧数据）」行显示中文名且能改 |
| 说明 | 与 S15~S54 的交付口径一致 |

## 5. 遗留

- **用户改状态不通知"被顶掉"的角色**：把某条任务从 `in_progress` 改回 `todo`/`done` 时，不会告知受派人"这条不用做了"（只有 `in_progress` 有激活通知）。真要补，应复用同一 `notify`（未做）。
- **面板仍不能改任务的标题/说明/受派人**：本轮只解决"状态"。要改派只能终止后重新派单（或让上游角色改派）。
- **右栏任务列表仍是只读**（`ui.md` §5 曾写它带"新建/改状态/终止/跳转"）——本轮把该表述改成与实现一致：右栏只做"项目级可见性 + 到会话里答复"，任务动作统一在「任务与产出物」。若希望右栏也能就地改状态，需要把 `WorkPanel` 的一套动作抽成共用组件（未做）。
- **Agent 侧仍不能"重新开工"自己的任务**：`task_claim` 要求 `todo`。若角色想接着做一条被终止/已完成的任务，需老板先改回 `todo`（或给工具加"重开"能力，未做）。
