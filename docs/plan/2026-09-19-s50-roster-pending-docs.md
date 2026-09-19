# S50 方案：按职能派单 / 待领取任务的领取与收口 / 文档产出统一进 `docs/`

> 日期：2026-09-19　类型：用户口径三条（① 产品经理根据角色的职能制定任务并分派；② 角色领取任务后无法自己标记完成，怎么解决；③ 角色产生的文档存放在 docs 文件夹里）　真源：`design/agent-runtime.md` §4/§6、`prd.md` FR-08 / FR-31
> 关联：`docs/changes/2026-09-19-s50-roster-pending-docs.md`、`docs/plan/development.md`

## 1 需求与现场诊断

### ① 产品经理根据角色的职能制定任务，并分派任务

现状：编排图里 PM 有 7 条出边（product/architect/dev/ops/qa/ux/ui），`task_assign` 也一直在用；**但 PM 的提示词里没有"团队有谁、各自职能是什么"**——只能靠它自己记得或猜。缺一个「团队与可委派对象」块。

### ② 角色领取任务后，无法自己标记完成任务

**先查证据（真实数据）**：

| 事实 | 数据 |
| --- | --- |
| `task_update done` 到底通不通？ | **通**。dev_1 在 14:03:33 成功汇报 `t_mu816a8djysou → done`（`tool_result: 已汇报任务 … → done`），任务记录最后一行确实是 `done` |
| 那问题在哪？ | **"领取"这一步断了**。该任务 06:53:02 创建（todo）→ dev_1 06:53:17 尝试 `task_claim` **失败**（它当时已有 in_progress 任务 `t_mu80mx9e7pmyy`，单工槽位被占）→ 之后**再没有任何提醒** → 任务在 `todo` 躺了 **7 小时**，直到 14:00:23 用户介入才领取成功、随即 done |
| 架构师侧同类现象 | 同一个 `task_claim` 在 13 分钟内被重试 4 次（#4/#19/#35/#50）——它在反复试，但没人告诉它"为什么不行、该怎么绕" |

根因：**`todo` 任务不进上下文**（规则 15 只注入 `in_progress`），"待领取"只靠发布时那**一条唤醒消息**（S36 已记录该文档漂移：设计文档声称的 `[待领取任务]` 块从来没实现）。消息被消费掉后，Agent 就再也看不到自己还有没领的活。

### ③ 角色产生的文档存放在 docs 文件夹里

现状：用户的真实工作目录里 `design.md` / `design-part2.md` 都在**根目录**。平台提示词里没有任何"文档放哪"的约定。

## 2 改动（三条各一处，互相独立）

| # | 改动 | 位置 |
| --- | --- | --- |
| ① | 新增上下文块「**团队与可委派对象**」（`team-roster`）：列出本项目每个角色（显示名 + 实例 id + 角色模板 + **模板 description 作为职能** + 停用标记），并给出**我当前可以直接派单的对象**（编排图出边）；无出边时明确说"不能派单给他人，用 ask_user 请老板安排" | `context-builder.ts` + `runner.ts`/`preview.ts` 取数 |
| ② | 新增上下文块「**待领取任务**」（`pending-tasks`）：列出**我名下 `todo` 任务**（id/标题/发起人/说明摘要）+ 行动指引"用 `task_claim` 领取；若被'你已有进行中的任务'挡住，先把那个任务收口（`task_update done/blocked`）或回报派发人" | 同上（`tasks.list({assignee, state:'todo'})`） |
| ③ | 平台角色定位里写明**文档目录约定**：doc 类产出物统一写到 `workdir://docs/…`，代码与测试按设计稿目录放 | `context-builder.ts` 的 `platform-role` 块 |

**数据来源**：团队成员 = `TeamService.listInstances`（含 `enabled`）；职能 = 角色模板 `description`（`RoleTemplateStore.list()`）；可派单对象 = `OrchestrationService.outgoingOf`；待领取 = `TaskService.list({assignee, state:'todo'})`。**runner 与系统提示词预览同源**（预览里也能看到这三块）。

**不改**：`task_assign` 的出边约束（铁律 2）；单工槽位规则（每人至多 1 个 in_progress）；`task_update` 的完成路径（本来就通）；不自动改已有文件路径（`docs/` 只是**新**产出的约定）。

## 3 验证方式

| 层 | 手段 |
| --- | --- |
| 单元 | 新增 `context-team-pending.test.ts`（7 条）：团队块（职能/停用标记/出边清单/无出边时的出口）、待领取块（任务行/说明/领取指引/无说明不留空行/为空不注入）、平台块含 `docs/` 约定 |
| **活体** | `GET /agents/pm_1/system-prompt` 断言：块顺序含 `team-roster` 且列出 **8 个角色 + 真实职能描述** + "你当前可以直接派单的对象：product_1、architect_1、dev_1、ops_1、qa_1、ux_1、ui_1"；平台块出现 `workdir://docs/design.md`（`pending-tasks` 在"无 todo 任务"时正确地不注入） |
| 回归 | `npm test` 全绿 + `coverage` + `ratchet` + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | ① 在 PM 会话里让它派活，它应能按职能点名（产品/架构/开发/测试/UI/交互/运维）② 给某角色派一条它还没领的任务 → 它下一回合就会 `task_claim`（被占槽位时会先收口或回报）③ 之后新产出的文档应落在工作目录的 `docs/` 下 |

## 4 风险

| 风险 | 对策 |
| --- | --- |
| 团队块让提示词变长（8 个角色 × 一句职能） | 职能取模板 `description`（一句话），实测整块约 400 字；`pending-tasks` 只在有 todo 时注入且说明截断 800 字 |
| 测试替身用"关键词命中提示词"判角色 → 被新块误伤 | 已踩到：`restart-recovery.test.ts` 用 `includes('架构师')` 判断"这是架构师"，新块把所有角色描述注入每个 Agent → 判据失效。**改为匹配角色提示词自己的句子**（`你是本项目的系统架构师`），并在用例里写明原因 |
| `pending-tasks` 与唤醒消息重复 | 唤醒消息仍是"即时触发"，块是"每回合可见"，两者互补；块里不重复唤醒文案，只给行动指引 |
| `docs/` 约定只是提示，Agent 可能不遵守 | 平台块每回合出现 + 写入 tool 说明；若实测仍乱放，再考虑在 `workdir_edit` 上做路径提示（属新口径） |
