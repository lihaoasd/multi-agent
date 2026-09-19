# 修改记录 · S50 按职能派单 / 待领取任务 / 文档进 `docs/`

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s50-roster-pending-docs.md](../plan/2026-09-19-s50-roster-pending-docs.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §4/§6、[prd](../requirements/prd.md) FR-08 / FR-31 / D53

## 1. 需求 / 问题（三条，各附现场证据）

### ① 产品经理根据角色的职能制定任务，并分派任务

PM 的出边与 `task_assign` 都在用（真实图里 PM → product/architect/dev/ops/qa/ux/ui 共 7 条边），但**提示词里没有"团队有谁、各自职能是什么"**——只能靠记忆或猜。

### ② 角色领取任务后，无法自己标记完成任务

查证结论：**`task_update done` 是通的，断的是"领取"**。

| 事实 | 数据（真实项目 `p_mu7rs071omcf1`） |
| --- | --- |
| 完成路径 | dev_1 于 14:03:33 成功汇报 `t_mu816a8djysou → done`；任务记录最后一行确为 `done` |
| 领取路径 | 该任务 06:53:02 创建（`todo`）→ dev_1 **06:53:17 领取失败**（当时已有 in_progress 任务）→ 之后**再无提醒** → 一直躺在 `todo`，直到 **14:00:23** 用户介入才领取成功 |
| 同类现象 | 架构师在 13 分钟内重复 `task_claim` 4 次（#4/#19/#35/#50）——反复试，但没人告诉它为何失败、怎么绕 |

根因：**`todo` 任务不进上下文**（规则 15 只注入 `in_progress`），"待领取"仅靠发布时那一条唤醒消息；消息消费掉后 Agent 就看不到自己还有没领的活（S36 已记录过这条文档漂移：设计文档声称的 `[待领取任务]` 块从未实现）。

### ③ 角色产生的文档存放在 docs 文件夹里

真实工作目录里 `design.md` / `design-part2.md` 都在**根目录**；平台提示词里没有任何"文档放哪"的约定。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| application | `src/application/agent-loop/context-builder.ts` | 新增 `ContextBlockOrigin` → `team-roster`；新增导出类型 `TeamMemberView`；新增块「**团队与可委派对象**」（成员 + 职能 + 停用标记 + 出边清单 / 无出边时的出口）与「**待领取任务**」（`todo` 任务 + 领取指引）；`platform-role` 块增"doc 产出物统一写 `workdir://docs/…`"约定；`BuildContextInput` 增 `team` / `delegatesTo` / `pendingTasks` |
| application | `src/application/agent-loop/runner.ts` | 取 `team.listInstances` + `roleTemplates.list`（职能=`description`）+ `orchestration.outgoingOf` + `tasks.list({assignee, state:'todo'})` 并注入上下文；`AgentLoopRunnerOptions` 增 `orchestration` / `roleTemplates` |
| application | `src/application/agent-loop/preview.ts` | 与运行期**同源**注入同样三块（`PromptPreviewServiceOptions` 增 `orchestration` / `roleTemplates`） |
| bootstrap | `src/bootstrap/composition-root.ts` | 给 runner 与 promptPreview 注入 `orchestration` + `roleTemplateStore` |
| tests | `tests/unit/application/context-team-pending.test.ts`（新 7）、`tests/integration/server/restart-recovery.test.ts`（修判据） | 见 §4 |
| docs | `prd`（**D53** + FR-08/FR-31 补注）、`agent-runtime.md` §4/§6、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s50` | 全链路回写 |

**未改**：`task_assign` 的出边约束（铁律 2）；单工槽位（每人至多 1 个 `in_progress`）；`task_update` 的完成路径（本来就通）；已有文件路径（`docs/` 只约束**新**产出）；UI（三块都在**系统提示词预览**里可见，无需新界面）。

## 3. 关键决定

1. **"按职能"用角色模板的 `description`**：它本来就是"这个角色负责什么"的一句话（实测输出如"测试工程师 qa_1（qa）：测试计划与用例、执行与缺陷报告"），不需要另造一份职能表。
2. **"可委派对象"用编排图出边**：与 `task_assign` 的校验同源（铁律 2），Agent 看到的可行集合与运行期判定一致，不会"以为能派却被拒"。
3. **"待领取"做成每回合块，而不是只靠唤醒**：一条消息会被消费掉、也会被长队列淹没；块是**每回合都可见**的行动项，并直接写明"被单工槽位挡住时怎么办"（收口当前任务或回报派发人）——这正是本次 7 小时僵尸任务的解法。
4. **`docs/` 是提示词级约定**：不动工具实现、不自动改路径；每回合出现 + 写入平台块，Agent 有据可依。
5. **runner 与预览同源**：预览即所见，便于用户自查（S36 的既定做法）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 新增单测 | `context-team-pending.test.ts` **7 passed**：团队块（职能 / 停用标记 / 出边清单 / 无出边时的出口 + `ask_user` / 无团队成员不注入）、待领取块（任务行 + 发起人 + 说明 + 领取指引 / 无说明不留空行 / 为空不注入）、平台块含 `docs/` 与 `workdir://docs/design.md` |
| **活体验证** | `GET /agents/pm_1/system-prompt`：块顺序 `role-config → platform-role → **team-roster** → global-memory → role-memory → session-window → delegated-tasks → artifact-index → tools`；`team-roster` 列出 **8 个角色 + 真实职能描述** + "你当前**可以直接派单**的对象（编排图出边）：product_1、architect_1、dev_1、ops_1、qa_1、ux_1、ui_1"；`platform-role` 含 `workdir://docs/design.md`；`pending-tasks` 在"当前没有 todo 任务"时正确地不注入 |
| 修掉一个被新块误伤的用例判据 | `restart-recovery.test.ts` 的替身网关原先用 `includes('架构师')` 判断"这是架构师"，而新块把**所有角色描述**注入每个 Agent 的提示词 → 判据失效（dev_1/qa_1 也被判成架构师去提问，回合卡在等答复）。改为匹配角色提示词自己的句子 `你是本项目的系统架构师`，并在用例里写明原因；**4 passed** |
| 全量测试 | `npm test` **64 files / 397 tests 全绿** |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-D5G05hX2.js`（1,377.19 kB / gzip 431.16 kB，本轮无前端改动） |
| **未覆盖** | 需要真实模型跑一轮才能确认 Agent 是否照做（按职能点名派单、领取、把文档写进 `docs/`）：**须用户点验** |
| 说明 | 与 S15~S49 的交付口径一致 |

## 5. 遗留

- **`[待领取任务]` 只列 `todo`**：`blocked` 的任务不进该块（它的处理路径是"汇报人继续跟进/派发人决定"，S36/D39 的「委派任务」块覆盖了派发人侧）。
- **`docs/` 只是提示**：已有 `design.md` 等文件不会被自动搬家；若 Agent 仍把文档丢在根目录，可考虑在 `workdir_edit`/`artifact_submit` 上加"doc 类建议路径"的提示（属新口径）。
- **团队块对单角色项目也会出现**（列出 1 个成员 + "你没有可委派对象"）：信息量不大但成本极低；若嫌冗余可按成员数 > 1 才注入。
- **`roleTemplates.list()` 每回合读一次**：模板库是本地小文件、且已按项目缓存；若将来模板很多再考虑缓存。
- **单工槽位仍是"硬约束"**：一个角色同时只能推进一件事（这是设计选择）；本次只是让"被挡住时该怎么办"变得可见。
