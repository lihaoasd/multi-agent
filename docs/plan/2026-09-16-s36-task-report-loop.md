# S36 方案：任务汇报闭环——派发人收到回报并「继续执行」

> 日期：2026-09-16　类型：用户指令（"角色领取任务后，执行完成，需要反馈任务，派发人接收到任务完成，继续执行任务"）　真源：`design/agent-runtime.md` §6、`design/data-storage.md` §7、`prd.md` FR-08 / FR-31
> 关联：`docs/changes/2026-09-16-s36-task-report-loop.md`、`docs/plan/development.md`

## 1 需求

用户口径：**受派人领取并完成任务后要汇报；派发人要真的收到"任务已完成"，并据此继续自己的工作。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 受派人**领取**后开工 | 已有能力：发布即通知受派人「待领取」+ `task_claim`（S7/D19-⑤，本轮不动） |
| R2 | 执行完成要**汇报** | 已有能力：`[当前任务]` 块要求 `task_update` 汇报 done（本轮不动） |
| R3 | 派发人**接收到任务完成** | 汇报后委派人被唤醒（注入系统消息 + `dispatcher.drain`）——已有通路，但**注入的只是一句事实** |
| R4 | 派发人**据此继续执行任务** | 通知里要有明确的"继续"指令；且委派人在任何回合都能看到**自己派出去的任务进展**，而不是只靠聊天记录回忆 |
| R5 | 不改后端接口 | `PATCH /tasks/:tid`、`GET /tasks`、会话日志接口契约不变 |

## 2 现状与影响面

链路四步逐条核对（S36 之前）：

| 步 | 位置 | 现状 | 判断 |
| --- | --- | --- | --- |
| ① 通知待领取 | `task-service.create` | `[任务] 你有一条待领取任务 t_x：标题。请用 task_claim 领取后开始。` | 够用 |
| ② 领取 | `task-service.claim` | `todo → in_progress`（单工槽位约束） | 够用 |
| ③ 汇报 | `[当前任务]` 块（`context-builder`） | "完成后用 task_update 汇报 done（平台会结算为可回退的产出物）" | 够用 |
| ④ **反向通知 + 继续** | `task-service.setState` → `notify` → 组合根 `wake` | 文本是纯事实：`[任务] dev_1 已汇报任务 t_x：done（note）`；**没有一句"你接下来做什么"** | **缺口** |
| ④' 派发人的视野 | `context-builder` | 只注入**自己的** `[当前任务]`（`task.activeFor`）；**看不到自己派出去的子任务**及其结果，被唤醒后只能从聊天流里找 | **缺口** |

结论：通路（唤醒 + drain）是通的，缺的是**"继续"的指令**与**"继续"所需的信息**。

另发现一处文档与代码漂移：`design/agent-runtime.md` §6 声称系统提示注入 `[待领取任务]`/`[当前任务]`/`[任务栏]` 三块，实际代码只有 `[当前任务]`（`ContextBlockOrigin = 'task-context'`）；"待领取"是靠唤醒消息传递的，`[任务栏]` 从未实现（对应能力是 `task_list` 工具）。本轮顺手把该行改成事实描述。

## 3 关键决定

1. **汇报通知从"播报"升级为"播报 + 指派下一步"**：保留 `[任务]` 前缀（既有脚本/约定按前缀识别平台任务通知），按状态给不同后续指引——`done`：基于该结果继续你的计划，若自己的任务已无后续则用 `task_update` 汇报自己；`blocked`：不要停在原地，调整方案后重新派单 / 自己接手 / 用 `ask_user` 澄清；`terminated`：决定是否重新安排。措辞**不点名 `task_assign`**（该工具只在 `pm` 白名单里，派发人不一定是 pm）。
2. **派发人上下文新增 `[委派任务]` 块**：列出"我委派出去的任务"（`creator = 我 && assignee ≠ 我`）及状态/备注，最近更新在前，最多 8 条（超出提示用 `task_list` 看全部）。这样"接收到"不依赖单条聊天消息，跨回合仍然成立。
3. **纯函数先行**：`taskReportNotice(...)`（汇报通知文案）与 `buildAgentContext` 的委派块生成都是纯逻辑，node 侧可单测（延续 S30/S33/S35 的做法）。
4. **端口扩展一处**：`TaskService.delegatedFor(projectId, instanceId)`（`creator=我`、按 `updatedAt` 倒序，排序与截断分权：服务只保证倒序，截断由上下文组装负责——提示词长度由组装方管）。`runner` 与 `preview`（系统提示词预览）**同源注入**，预览里能看见该块。
5. **不加"领取通知"**：`claim` 若也通知派发人，会为"知道对方开工了"多烧一轮模型调用，收益不抵噪声；派发人真正需要的是**结果**。
6. **不动询问答复文案**：`[询问]` 答复通知同样是"纯事实"，但本轮用户只要求任务闭环；同类问题记入遗留，不顺手改（避免超出需求）。

## 4 实现步骤

- `src/application/task/task-service.ts`：导出纯函数 `taskReportNotice({assignee, taskId, title, state, note})`；`setState` 的汇报通知改用它；新增 `delegatedFor`（`store.list({creator})` → 过滤 `assignee !== 自己` → `updatedAt` 倒序）。
- `src/ports/task.ts`：`TaskService` 增 `delegatedFor`（含契约注释）。
- `src/application/agent-loop/context-builder.ts`：`BuildContextInput` 增可选 `delegatedTasks`；`MAX_DELEGATED_TASKS_IN_PROMPT = 8`；在 `[当前任务]` 之后追加块（id `delegated-tasks`，origin 复用 `task-context`，避免前端预览新增标签）。
- `src/application/agent-loop/runner.ts` / `preview.ts`：取 `delegatedFor` 并传入（非空才注入）。
- 测试：`tests/unit/application/task-report-notice.test.ts`（三状态 + note 缺省）、`tests/unit/application/context-delegated-tasks.test.ts`（块存在/排序/截断/空不注入）、`tests/integration/server/task-report-continuation.test.ts`（脚本化网关端到端：dev 汇报 → pm 收到通知并**真的继续**派下一单）。
- 文档回写：`prd` **D39** + FR-08/FR-31 补注、`design/agent-runtime.md` §6 漂移修正、`README.md` / `plan/development.md` / `testing/plan.md`、验收阶段清单加 `s36`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `task-report-notice`（3+）、`context-delegated-tasks`（4+） |
| 集成 | `task-report-continuation`：断言 ① 派发人会话出现含"继续"的汇报通知；② 派发人的系统提示词预览出现 `[委派任务]` 块且含子任务状态；③ 派发人**在同一轮/随后一轮真的发起新的工具调用**（继续执行） |
| 回归 | `npm test` 全绿 + `npm run coverage`（142/142 文件可达）+ `npm run ratchet` + `npm run build` |
| **用户点验** | ① 让 pm 派单给 dev；② dev 完成后汇报；③ 到 pm 会话看到回报通知（含"请据此继续"）且 pm **接着做事**（发起新工具调用/新消息），不是只回一句"收到"；④ 在 pm 的「提示词预览」里能看到 `[委派任务]` 块与子任务状态 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 通知变长导致派发人"念一遍就停" | 文案把"继续"写成主句（`请据此继续你的计划：…`），并给出"无事可做时怎么收尾"（`task_update` 汇报自己）的明确出口 |
| `[委派任务]` 块长期累积撑大提示词 | 按 `updatedAt` 倒序截断到 8 条，超出只给一行"另有 N 条，用 task_list 查看" |
| 截图式验证不了"是否真的继续" | 集成用例用脚本化网关断言**派发人发起了新的 `task_assign`**（可回归），而不只断言文案 |
| 委派人无 `task_assign`（非 pm）时被误导 | 文案只点名所有角色都有的 `task_update`（与 `ask_user`），派单/接手用自然语言描述 |
| 唤醒是异步的，用户看不到"立刻" | 现有 `wake` 语义不变（append + drain）；测试用 `waitFor` 轮询会话日志 |
