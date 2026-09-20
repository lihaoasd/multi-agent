# S55 方案：「任务与产出物」里任务状态可改（修两处拦路 + 激活即唤醒）

> 日期：2026-09-20　类型：用户报告（"任务与产出物里任务状态是不能修改的"）　真源：`prd` FR-08 / D17-① / D18-③、`data-storage.md` §7、`agent-runtime.md` §6、`ui.md` §5
> 关联：`docs/changes/2026-09-20-s55-task-state-editable.md`、`docs/plan/development.md`
> 用户原话：**"任务与产出物里任务状态是不能修改的"**

## 1 需求与根因

面板上确实有状态下拉（`WorkPanel` 任务表「操作」列），但**能改成功的场景很窄**，另外**改完角色也不动**：

| # | 现象（代码级） | 为什么用户会觉得"不能修改" |
| --- | --- | --- |
| ① | `TaskService.setState` 只允许 **`todo` → `in_progress`**：`if (state === 'in_progress' && task.state !== 'todo') return ERR_CONFLICT` | 老板想把一条**已完成/已终止**的任务重新开工（很自然的动作），点「进行中」只会得到一句报错；这条限制本来是给 Agent 的 `claim`（先排队再开工）用的，不该管到用户 |
| ② | 该角色**已有进行中的任务**时，置新任务为 `in_progress` → `ERR_CONFLICT`（`detail.holding`），界面没有任何出路 | 用户的项目里 qa_1 / architect_1 / dev_1 / ui_1 **各自都有一条进行中任务**，于是"把某条待领取的活开工"这个动作**必然失败** |
| ③ | 下拉里**包含当前状态** | 选它 → `ERR_CONFLICT：任务已是 X 状态`——什么都没改却报错 |
| ④ | 历史 `blocked` 行的下拉显示原始值 `blocked`（`value` 不在 `options` 里，antd 回退显示原始值） | 看到英文值，像是"改不了" |
| ⑤ | **用户改状态不唤醒角色**：`setState` 只在 `done/terminated` 时通知委派人；`create` 通知「待领取」——**`in_progress` 这条路径从不通知** | 状态改了，但受派人不知道要开工（文档 `agent-runtime.md` §6 与 `orchestration.md` §5 早写着"**激活即唤醒**：任务置 `in_progress` 时向受派者注入唤醒消息"，实现只落在 `create`/`claim` 之外的路径上） |
| ⑥ | 失败反馈只进面板顶部 `Alert`，没有就近提示 | 表格长（用户项目 14 条任务）时容易以为"点了没反应" |

## 2 改动

| # | 改动 | 落点 |
| --- | --- | --- |
| ① | **老板可以改成任何状态** | `setState`：`state==='in_progress' && task.state!=='todo'` 的限制**只对 `actor!=='user'` 生效**——用户（面板/API 缺省 actor）可以从 `done`/`terminated`/`blocked` 直接重新开工；Agent 侧仍必须 `todo` → `claim`（口径不变，防绕过排队） |
| ② | **单工槽位不放宽，但给"出路"** | `in_progress` 仍要求该角色没有别的进行中任务（`activeFor`/任务上下文/会话顶部标签都以"至多一个"为前提），但报错文案改成可执行的「先把它标为已完成或已终止，再开工这条」并带上 `detail.holding` + `holdingTitle`；面板据此弹确认"**收口它并开工**"（两步调用同一接口） |
| ③ | **下拉不提供"当前状态"** | 纯函数 `taskStateOptions(current, labels)`：排除当前状态；当前状态是历史值（`blocked`）时补一条**禁用**占位项（显示「受阻（旧数据）」而不是 `blocked`） |
| ④ | **激活即唤醒落地** | `setState` 置为 `in_progress` 且 `actor !== assignee` 时，经组合根的 `notify`（系统消息 + 唤醒一轮）通知受派人：「[任务] 用户把任务 t_x 置为进行中：《title》。请开始执行…」 |
| ⑤ | **反馈就近** | `message.success('「标题」→ 已完成')` / `message.error(原因)`；`terminated` 前按 D17-① 出确认（说明会先结算未结算改动为 code 产出物快照）；槽位冲突走 `Modal.confirm` |
| ⑥ | **纯逻辑可测** | `web/src/lib/task-state.ts`：`SELECTABLE_TASK_STATES`、`taskStateOptions`、`holdingTaskOf` |

**不改**：`blocked` 仍不接受新迁移（S53/D57）；单工槽位规则本身；`claim` 的 `todo` 前置；`done`/`terminated` 的结算与通知委派人；任务字段（标题/说明/受派人）在面板上仍不可编辑（本轮只解决状态）。

## 3 验证方式

| 层 | 手段 |
| --- | --- |
| 单元（服务） | `task-question-service.test.ts` +2：① `actor='user'` 可从 `todo` 直接开工、`done → in_progress` 可重开、`actor='dev_1'` 仍 `ERR_CONFLICT`，且激活时向受派人投递"置为进行中"通知 ② 槽位冲突返回 `ERR_CONFLICT` + `holding`/`holdingTitle`，按"先收口再开工"两步调用都能成功 |
| 单元（前端纯逻辑） | 新增 `tests/unit/web/task-state.test.ts`（4）：不含 `blocked`；**每个状态下拉都排除当前状态**且长度 = 4−1；`blocked` 行补禁用占位项（中文名）；`holdingTaskOf` 的兜底与非法输入 |
| 集成（HTTP） | `work-api.test.ts` 规则 15/24 扩展：缺省 actor（＝user）把 `done` 任务改回 `in_progress` → 200，受派人会话出现"置为进行中"系统消息；同一动作 `actor=dev_1` → 409 |
| 回归 | `npm test` **68 files / 426 tests 全绿**；`coverage` 143/143、`ratchet` 0、`typecheck`/`eslint`/`build` 通过 |
| **活体验证**（运行中的实例，**临时项目**，验完即删） | ① 建临时项目 → 派单（`todo`）② 缺省 actor 置 `in_progress` → 200 ③ 置 `done` 后再置 `in_progress` → **200（S55 之前必 409）** ④ 受派人会话出现「置为进行中」系统消息 ⑤ 同动作 `actor=dev_1` → 409（Agent 口径不变）⑥ 删除临时项目，项目列表恢复为只剩「贪吃蛇」 |
| **用户点验** | 「任务与产出物」任务表：每条任务的下拉里**没有它自己的当前状态**；把一条已完成/已终止的任务改成「进行中」应当**直接成功**（该角色手上有别的活时会先问"收口它并开工吗"）；改完受派人会被唤醒；历史「受阻（旧数据）」行显示中文名且能改成新状态 |

## 4 风险

| 风险 | 对策 |
| --- | --- |
| 放宽后出现"两个进行中" | 没有放宽槽位：仍返回 `ERR_CONFLICT`，只是把出路做成一次确认（先 `done` 旧的，再开工新的），槽位始终唯一 |
| 老板重开一条已完成任务，受派人被反复唤醒 | 只在**跨角色**置位（`actor !== assignee`）时通知；受派人自己置位不通知自己 |
| 通知失败阻断状态变更 | 沿用既有口径：`notify` 失败只 `logger.warn`，状态变更照旧成功 |
| 误点「终止」造成结算 | 终止前 `Modal.confirm`（写明"会先结算为一条 code 产出物快照（可回退）"），且终止后可改回待领取 |
| 界面状态与列表不同步 | 每次变更后 `await load()`；成功/失败都用 `message` 就近反馈 |
