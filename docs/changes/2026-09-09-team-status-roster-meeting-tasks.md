# 2026-09-09 团队状态显示 / PM 只协调 / 全员名册与开会 / 任务状态自管

> 类别：changes · 需求来源：用户四条要求（团队状态、PM 不产出、角色相互可见且都能开会、任务状态角色自管）
> 方案见 [docs/plan/2026-09-09-team-status-roster-meeting-tasks.md](../plan/2026-09-09-team-status-roster-meeting-tasks.md)

## 1) 团队列表显示角色状态

- 新路由 `GET /api/projects/:pid/agents`：合并 team + occupancy + 进行中任务 + 待批审批/待答提问，返回
  `{instanceId, displayName, roleTemplateId, enabled, state, sessionId, since, currentTask}`；
  状态推导：`disabled`（停用）/`meeting`（会议中）/`working`（工作中）/`waiting`（等你处理审批或提问）/`idle`（空闲）。
- 前端左栏团队行新增状态徽标（空闲/工作中/会议中/等待你处理/已停用）+ 当前任务 hover 提示；
  `refreshPanels()` 与 WS `agent.state` 事件都会刷新，另加 5s 轮询兜底（离开项目时清理定时器）。

## 2) PM 只协调、不产出

- `pm.yaml`：提示词明确"只沟通与协调，不产出任何交付物"，需要产出必须 `task_assign` 派给对应角色；
  工具白名单移除 `artifact_submit`、`artifactTypes: []`（保留 ws_write 作私有笔记）。
- PM 本就没有 `workdir_edit`/`cmd_run`，无法写项目工作目录 → 语义与实现一致。

## 3) 每个角色都知道彼此 + 每个角色都能发起会议

- `SessionService.fillAssignables()` 改为对**所有角色**注入团队名册（仍只列 enabled）；
  `loop-runner` 新增 `[团队成员] 我：dev_1（高级开发）｜其他成员：pm_1（项目经理）、…` 提示段。
- 注册此前只在模板里、未实现的会议工具（user 会话所有角色可用）：
  - `meeting_start{topic, desc, members[], agenda?}`：任意角色发起；校验参会人存在且启用、不含自己；
    创建后**平台代受邀 AI 成员接受**（会议进入 `open`，各角色占用=会议中），结果里返回会议 id 与参会人。
  - `meeting_close{meetingId}`：仅主持人可结束（生成纪要）。
- `MeetingService.respond` 允许"会议已 open 时未回应成员补回应"（接受=补入会占用），使自动接受能覆盖全部受邀成员。

## 4) 任务状态由角色自己维护

- `TaskService.setState` 权限改为：`user` / **受派者本人** /（甲模式下）协调者；
  `done`、`terminated` 不再强制 user；保留：每角色至多 1 个 `in_progress`、终态不可回退、done/terminated 前先结算 code 改动；
  唤醒只在"非受派者置 in_progress"时触发（避免自己唤醒自己）。
- 新工具 `task_update{taskId?, state, note?}`：默认作用于 `env.taskId`（当前激活任务），供角色汇报 开工/完成/受阻；
  系统提示在 `[当前任务]` 中明确要求"完成后必须调用 task_update 上报，不要只口头说完成"。
- 前端任务面板去掉"开工/完成/终止"按钮，改为只读状态徽标 + 提示"状态由角色自行汇报"。

## 关键文件

`src/server/app.ts`、`src/application/attention/*`（不变）、`src/application/session/session-service.ts`、
`src/application/agent-loop/loop-runner.ts`、`src/application/dispatcher/occupancy-store.ts`、
`src/application/meeting/meeting-service.ts`、`src/application/task/task-service.ts`、
`src/application/tools/service-tools.ts`、`src/application/composition.ts`、`src/shared/roles/pm.yaml`、
`web/app.js`、`web/style.css`、`tests/team-status-m8i.test.ts`。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **139 用例全绿**
  （新增 `tests/team-status-m8i.test.ts` 5 例：agents 五种状态与当前任务；受派者自行开工/完成、非受派者被拒；
  `task_update` 工具完成上报；任意角色 `meeting_start` → open + 参会人占用=会议中 + 主持人 `meeting_close`；
  `meeting_start` 参数校验）。旧的 `tasks-m8b` 断言仍成立（非受派者角色在乙模式下仍被拒）。
- 真实模型冒烟（deepseek-v4-flash）：dev 能准确列出 `pm_1/product_1/qa_1`（名册生效）；
  dev 用 `meeting_start` 发起「接口对齐」评审会 → 会议 `open`，`pm_1/qa_1/dev_1` 状态均为 `meeting`；
  dev 用 `task_update` **自行**把任务从 `in_progress` 改为 `blocked`（如实上报"接口文档未产出"，未谎报完成）。
- 顺带修复：回合结束的 occupancy 释放改为**只释放本回合会话**，避免回合中入会的主持人状态被误清空。

## 遗留（说明）

- 会议议程推进/逐人发言仍由 UI 或主持人点名（`meeting_talk` 工具后续）；`meeting_advance/ask_user` 工具未注册。
- 角色状态 `waiting` 只覆盖"审批/提问待用户处理"；不含"排队等会议开始"等更细态。
- 任务 `todo` 队列不自动调度（仍由协调者/受派者推进）。
