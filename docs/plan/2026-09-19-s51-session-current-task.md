# S51 方案：会话顶部显示该角色「正在执行的任务」

> 日期：2026-09-19　类型：用户口径（"领取任务后，对应的角色会话顶部显示正在执行的任务"）　真源：`design/ui.md` §4、`prd.md` FR-08 / FR-29
> 关联：`docs/changes/2026-09-19-s51-session-current-task.md`、`docs/plan/development.md`

## 1 需求

用户口径：**领取任务后，对应的角色会话顶部要显示"正在执行的任务"。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 会话顶部显示**该角色正在执行的任务** | 会话卡片标题旁出现 `正在执行：<任务标题>` 的标签（蓝），鼠标悬停显示 `任务 <id>｜<state>` |
| R2 | **只显示自己的** | 切到别的角色会话时不显示它的任务（各看各的） |
| R3 | 领取后出现、收口后消失 | 任务 `in_progress` 时出现；`done`/`blocked`/`terminated` 后消失 |
| R4 | 不改交互 | 顶部原有的「对话/详细日志」切换、刷新、暂停、新对话等按钮位置不变 |

## 2 现状与缺口

| 位置 | 现状 |
| --- | --- |
| `GET /agents` 状态投影 | **`currentTask` 是硬编码 `null`**（`src/server/http-routes/projects.ts`），前端根本没有这个字段 |
| 运行细条（拓扑页顶部） | 已经有 `taskTitle`（来自 `tasks.activeFor`）——**说明数据早就有了，只是会话页没接** |
| 会话卡片标题 | 只有 `显示名｜会话 id` |

## 3 关键决定

1. **后端在既有状态投影上补字段**：`currentTask: {id,title,state} | null`——与会话左栏/画布/细条同一条数据流（S38 加 `waitingFor` 的做法一致），前端不再额外请求。
2. **一次取全项目再按受派人分组**：`tasks.list(pid, {state:'in_progress'})` 一次读盘，`Map<assignee, task>`；避免每个实例各查一次（`/agents` 是热点接口）。
3. **只在会话顶部展示**（用户口径）：不放左栏列表（S19 刚收敛为"名称 + 状态"，不再塞第二行），也不改右栏任务列表。
4. **状态的真相仍是任务记录**：前端只是展示；任务收口（done/blocked/terminated）后 `activeFor` 不再命中 → 标签自然消失。
5. **不改接口路径与其它字段**：纯增字段，旧前端（无该字段）不受影响。

## 4 实现步骤

- `src/server/http-routes/projects.ts`：`/agents` 组装处取 `context.tasks.list(pid, {state:'in_progress'})` 并按 assignee 建映射，把 `currentTask` 从 `null` 改为真实任务（无则 `null`）；`ProjectRouteContext` 增 `tasks`。
- `src/server/app.ts`：注册项目路由时传入 `tasks: options.services.tasks`。
- `web/src/api/sessions.ts`：`AgentStatus` 增可选 `currentTask?: {id,title,state} | null`。
- `web/src/pages/SessionPanel.tsx`：会话卡片 `title` 改为 `Space`，在 `显示名｜会话 id` 之后渲染 `正在执行：<标题>` 标签（`Tooltip` 给 `任务 <id>｜<state>`）。
- 测试：`tests/integration/server/work-api.test.ts` 的任务闭环用例增断言——领取后 `currentTask` 命中、**其它角色为 null**；收口后回到 `null`。
- 文档回写：`prd` **D54** + FR-08/FR-29 补注、`ui.md` §4、`contract.md`（`/agents` 字段）、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s51`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 集成 | `work-api.test.ts`：`PATCH tasks/:id {state:'in_progress'}` 后 `/agents` 的 `dev_1.currentTask = {id,title,state}`；`pm_1.currentTask = null`；`done` 后 `dev_1.currentTask = null`（**6 passed**） |
| **端到端（临时实例）** | 备用端口 3103 + 临时数据目录：建项目 → 建任务 `验证：正在执行的任务显示` → `in_progress` → `/agents` 显示 `dev_1（working）currentTask = t_… / 标题 / in_progress`，其余 7 个角色为 `—`；改 `done` 后 `currentTask = null` |
| 回归 | `npm test` 全绿 + `coverage` 143/143 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | 让某角色领取一条任务 → 该角色会话顶部出现「正在执行：<标题>」；切到别的角色会话看不到它；任务收口后标签消失 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| `/agents` 多一次任务读盘（热点接口） | 一次读全项目 in_progress（不是每实例一次）；任务文件是本地小文件，实测无感 |
| 标题过长挤坏标题栏 | 标签 `maxWidth: 420px` + 省略号；完整标题与 `id`/`state` 放 Tooltip |
| 与"左栏只显示名称+状态"冲突 | 只在**会话卡片顶部**（用户指定位置）显示，左栏不动 |
| 任务状态与占用不一致（已 done 但仍 working） | 标签由任务记录驱动、`state` 由 occupancy 驱动，两者可能短暂错位；这正是"谁在干什么"的真实全貌，不做额外掩盖 |
