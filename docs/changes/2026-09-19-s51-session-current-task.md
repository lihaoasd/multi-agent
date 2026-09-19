# 修改记录 · S51 会话顶部显示「正在执行的任务」

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s51-session-current-task.md](../plan/2026-09-19-s51-session-current-task.md)
> 关联设计：[ui.md](../design/ui.md) §4、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-08 / FR-29 / D54

## 1. 需求 / 问题

用户口径：**"领取任务后，对应的角色会话顶部显示正在执行的任务。"**

现状：`GET /agents` 的状态投影里 `currentTask` **硬编码为 `null`**（`src/server/http-routes/projects.ts`），前端也没有这个字段——所以会话顶部没有任务可显示。而数据其实早就有：拓扑页运行细条用的 `RuntimeAgentView.taskTitle` 就是 `tasks.activeFor` 的结果。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| server | `src/server/http-routes/projects.ts` | `/agents` 组装：`tasks.list(pid, {state:'in_progress'})` **一次取全项目** → `Map<assignee, {id,title,state}>` → `currentTask`（无则 `null`）；`ProjectRouteContext` 增 `tasks` |
| server | `src/server/app.ts` | 注册项目路由时传 `tasks: options.services.tasks` |
| web | `web/src/api/sessions.ts` | `AgentStatus` 增可选 `currentTask?: {id,title,state} \| null` |
| web | `web/src/pages/SessionPanel.tsx` | 会话卡片 `title` 改为 `Space`：`显示名｜会话 id` 之后渲染蓝色标签 **`正在执行：<标题>`**（`Tooltip`：`任务 <id>｜<state>`；`maxWidth: 420` + 省略号） |
| tests | `tests/integration/server/work-api.test.ts` | 任务闭环用例增断言：领取后 `dev_1.currentTask` 命中、`pm_1.currentTask = null`、`done` 后回到 `null` |
| docs | `prd`（**D54** + FR-08/FR-29 补注）、`ui.md` §4、`contract.md`（`/agents` 字段）、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s51` | 全链路回写 |

**未改**：接口路径与其它字段（纯增字段）；左栏会话列表（S19 刚收敛为"名称 + 状态"，不塞第二行）；右栏任务列表；运行细条（它本来就有 `taskTitle`）；任务状态机与单工槽位。

## 3. 关键决定

1. **走既有状态投影**：`currentTask` 加在 `/agents` 上（与 S38 加 `waitingFor` 同一思路）——会话左栏、画布、细条、会话顶部共享同一条数据流，前端不再各自请求。
2. **一次读盘、按受派人分组**：避免 `/agents`（热点接口）对每个实例各查一次任务。
3. **只放在会话顶部**（用户指定位置）；标题过长用省略号 + Tooltip 全文。
4. **状态真相归属任务记录**：任务收口后 `in_progress` 不再命中 → 标签自然消失，无需前端额外判断。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 集成 | `work-api.test.ts` **6 passed**：领取后 `dev_1.currentTask = {id, title:'实现登录模块', state:'in_progress'}`、**其它角色 `currentTask = null`**；任务 `done` 后 `dev_1.currentTask = null` |
| **端到端（临时实例）** | 备用端口 3103 + 临时数据目录：建项目 → 建任务 → `in_progress` → `/agents` 显示 `dev_1（working）currentTask = t_mu8gzvkq349yx / 验证：正在执行的任务显示 / in_progress`，其余 7 个角色为 `—`；改 `done` 后 `currentTask = null`（临时实例已停止并清理） |
| 全量测试 | `npm test` **64 files / 397 tests 全绿** |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BEjLg3iO.js`（1,377.51 kB / gzip 431.25 kB） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— ① 领取任务后该角色会话顶部出现「正在执行：<标题>」② 切到别的角色看不到 ③ 任务收口后标签消失 |
| 说明 | 与 S15~S50 的交付口径一致 |

## 5. 遗留

- **只显示标题**：不带进度（`plan` 步数）与任务类型；运行细条那边的 `planStatus` 是另一条数据流，若要在会话顶部也显示"第几步"，需要再取一次 plan 事件。
- **不显示"待领取"**：会话顶部只反映 `in_progress`（用户口径是"正在执行"）；待领取信息在上下文块（S50）与右栏任务列表里。
- **任务状态与占用可能短暂错位**：标签由任务记录驱动、左栏状态由 occupancy 驱动（例如刚 `done` 但回合还在收尾）——视为真实全貌，不做掩盖。
- **`/agents` 增一次任务读盘**：本地小文件、一次读全项目；若将来任务量很大，可把 in_progress 索引缓存进 dispatcher 状态。
