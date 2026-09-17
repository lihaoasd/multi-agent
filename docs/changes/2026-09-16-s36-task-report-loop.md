# 修改记录 · S36 任务汇报闭环：派发人收到回报并「继续执行」

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s36-task-report-loop.md](../plan/2026-09-16-s36-task-report-loop.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §4/§6、[data-storage.md](../design/data-storage.md) §7、[prd](../requirements/prd.md) FR-08 / FR-31 / D39

## 1. 需求 / 问题

用户口径：**"角色领取任务后，执行完成，需要反馈任务，派发人接收到任务完成，继续执行任务"**。

逐条核对链路（S36 之前）：

| 步 | 现状 | 判断 |
| --- | --- | --- |
| ① 发布即通知受派人「待领取」 | `task-service.create` 注入 `[任务] 你有一条待领取任务 …。请用 task_claim 领取后开始。` | 够用 |
| ② 领取 | `task_claim` → `todo → in_progress`（单工槽位约束） | 够用 |
| ③ 完成后汇报 | `[当前任务]` 块要求 `task_update` 汇报 done | 够用 |
| ④ **反向通知委派人** | 通路在（注入系统消息 + `dispatcher.drain` 唤醒），但文案是**纯事实**：`[任务] dev_1 已汇报任务 t_x：done（note）`——**没有一句"你接下来做什么"** | **缺口** |
| ④' **委派人的视野** | 上下文只有**自己的** `[当前任务]`（`task.activeFor`），**看不到自己派出去的子任务**及其结果 | **缺口** |

即：通路是通的，缺的是**"继续"的指令**与**"继续"所需的信息**。用户观察到的现象（委派人回一句"收到"就停）由此而来。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| application | `src/application/task/task-service.ts` | 新增导出纯函数 **`taskReportNotice({assignee, taskId, title, state, note})`**：前缀保留 `[任务]`，正文 = 事实行 + `说明：<note>`（note 空白则省略）+ **下一步指令**（`done` / `blocked` / `terminated` 三种口径）；`setState` 的委派人通知改用它。新增 **`delegatedFor(projectId, instanceId)`**：`creator=我 && assignee≠我`，`updatedAt` 倒序 |
| ports | `src/ports/task.ts` | `TaskService` 增 `delegatedFor`（含契约注释） |
| application | `src/application/agent-loop/context-builder.ts` | `BuildContextInput` 增可选 `delegatedTasks`；导出 `MAX_DELEGATED_TASKS_IN_PROMPT = 8` 与 `delegatedTaskLine(task)`；在 `task-context` 之后注入 `delegated-tasks` 块（origin 复用 `task-context`，不新增前端标签） |
| application | `src/application/agent-loop/runner.ts`、`preview.ts` | 取 `delegatedFor` 并传入（非空才注入）——**运行期与系统提示词预览同源** |
| tests | `tests/unit/application/task-report-notice.test.ts`（5）、`tests/unit/application/context-delegated-tasks.test.ts`（4）、`tests/integration/server/task-report-continuation.test.ts`（1） | 见 §4 |
| docs | `prd`（**D39** + FR-08/FR-31 补注）、`agent-runtime.md` §4/§6（含**文档漂移修正**）、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s36` | 全链路回写 |

**未改**：后端接口（`PATCH /tasks/:tid`、`GET /tasks`、会话日志均不变）；前端（本轮无 UI 改动，产物哈希不变）；`claim`（不加"领取通知"）；询问答复通知文案（同类"纯事实"问题，见遗留）；S21 的"未完成回合由 Agent 自查"口径。

## 3. 关键决定

1. **通知从"播报"升级为"播报 + 指派下一步"**：`done` → "请据此继续你的计划：基于这个结果推进下一步；若你的任务因此已无后续，用 `task_update` 汇报你自己任务的结论"；`blocked` → "请立即安排后续：调整方案后重新派单、自己接手，或用 `ask_user` 向用户澄清——**不要停在原地等待**"；`terminated` → "请决定是否重新安排这项工作"。保留 `[任务]` 前缀（平台任务通知的既有约定，脚本/用例按它识别）。
2. **措辞不点名 `task_assign`**：该工具只在 `pm` 的工具白名单里（S25 的"装载 ≠ 授权"），而委派人理论上不一定是 pm；只点名所有角色都有的 `task_update`/`ask_user`，派单与接手用自然语言描述。
3. **`[委派任务]` 块让"接收到"跨回合成立**：只靠一条聊天消息，委派人在后续回合就"忘了"子任务干到哪；块里列出 `creator=我 && assignee≠我` 的任务（状态 + 备注，`updatedAt` 倒序、最多 8 条，超出给"另有 N 条，用 `task_list` 查看全部"），并写明"回报到达后据此继续你自己的计划"。
4. **排序在服务、截断在组装**：`delegatedFor` 只保证倒序（数据语义），提示词条数上限由上下文组装负责（提示词长度是组装方的事）。
5. **不加"领取通知"**：让委派人"知道对方开工了"要多烧一轮模型调用，收益不抵噪声；委派人真正需要的是**结果**。
6. **发现并修正文档漂移**：`agent-runtime.md` §6 声称系统提示注入 `[待领取任务]`/`[当前任务]`/`[任务栏]` 三块，实际代码只有 `[当前任务]`（"待领取"靠发布时的唤醒消息传递，`[任务栏]` 从未实现、对应能力是 `task_list`/`task_view`）。本轮把该行改成事实描述，并补上新增的 `[委派任务]`。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（`tsc -p tsconfig.json` + `tsc -p web/tsconfig.json`；`npx eslint .`） |
| 新增单测 | `task-report-notice` **5 passed**（`done`/`blocked`/`terminated` 三种文案 + note 空与非空 + 不点名 `task_assign`）；`context-delegated-tasks` **4 passed**（空不注入 / 任务行与"据此继续" / 超 8 条截断 / 无备注不留空括号） |
| **端到端（关键）** | `tests/integration/server/task-report-continuation.test.ts` **1 passed**：脚本化网关下 pm 沿出边派单给 dev → dev `claim` 并汇报 `done` → 断言 ① pm 会话出现通知且含"请据此继续你的计划"与备注 ② **pm 真的发起下一步 `task_assign`**（不是只回一句话）③ pm 的系统提示词预览出现 `delegated-tasks` 块并含子任务 `done` |
| 全量测试 | `npm test` **53 files / 343 tests 全绿**（S35 基线 50 / 333） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0**（基线 0） |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-D9Oh5z_A.js` **与 S35 相同**（1,372.98 kB / gzip 429.73 kB）——本轮无前端改动，符合预期 |
| **未覆盖** | "真实模型是否真的继续干活"取决于模型与提示词；已用脚本化网关把**平台侧**行为钉死（通知内容 + 上下文块 + 唤醒），**仍须用户在一次真实项目里点验**：让 pm 派单 → dev 完成后汇报 → 看 pm 是不是接着做事 |
| 说明 | 与 S4/S7/S12/S15~S35 的交付口径一致 |

## 5. 遗留

- **询问答复通知仍是"纯事实"**：`question-service.answer` 注入 `[询问] 用户已回答你的提问「…」：…`，同样没有"据此继续"的指令。本轮按需求边界未动（用户只提了任务闭环）；若要统一，做法与 `taskReportNotice` 相同。
- **`[任务栏]` 仍未实现**：文档原先声称的"上游 Agent 依出边发布指引"块不存在；当前 Agent 靠 `task_list`/`task_view` 主动查。若要让 Agent 每回合天然看到"可派单的出边与待办"，需要新增块（超出本轮需求）。
- **`claim` 不通知委派人**：委派人无法从通知里知道"对方已开工"（只能从任务状态/`task_list` 看到）。若实际出现"委派人重复催单"，再考虑补一条轻量通知。
- **`delegated-tasks` 只列 8 条**：长项目里更早的子任务会被折叠成一行提示；没有分页/按状态筛选（需要时用 `task_list`）。
- **每回合多一次 `tasks.jsonl` 读**：`delegatedFor` 与 `activeFor` 一样走 `readAll`（无缓存）；本地单用户规模下可忽略，若将来任务量大再考虑按回合缓存。
- **前端仍无 DOM/组件测试**（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35 记录）。
