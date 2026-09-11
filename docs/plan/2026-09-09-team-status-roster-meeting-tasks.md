# 开发方案：团队状态显示 / PM 只协调 / 全员名册与开会 / 任务状态自管 · 2026-09-09

> 需求来源（用户口述）：
>
> 1. 团队列表里需要显示角色的状态；
> 2. 项目经理只协调工作，不参与项目的输出；
> 3. 每个角色都知道其他角色的存在，每个角色都可以发起会议；
> 4. 任务列表不需要用户点击完成和终止，由角色自己修改状态。

## 1. 现状与问题

- **角色状态**：占用状态落在 `runtime.state.json`（occupancy：working/meeting/waiting），但没有对外 API，UI 团队行只显示名字与停用标记。
- **PM 产出**：`pm.yaml` 的提示词已写"只沟通不产出正文"，但工具白名单里仍有 `artifact_submit`、`artifactTypes: [doc]`，语义不一致。
- **角色相互可见**：`SessionService.fillAssignables()` 只对 `pm/product` 注入"可指派对象"清单；其他角色**完全不知道队友**（见上一轮结论）。
  会议工具 `meeting_*` 从未注册进执行器 → 只有用户在 UI 点"发起会议"，角色无法发起。
- **任务状态**：`TaskService` 规则里 `done/terminated` 仅 `user` 可置、非 user 状态流转在乙模式下被拒；UI 任务面板提供"开工/完成/终止"按钮 → 与"角色自管"的诉求相反。

## 2. 改动

### A. 团队名册（每个角色都知道彼此）

- `SessionService.fillAssignables()` → 对所有角色生效（不再限于 pm/product），仍只列 enabled 成员，附 `roleTemplateId`。
- `loop-runner.buildSystemPrompt()` 新增 `[团队成员] 我：dev_1（高级开发）｜其他成员：pm_1（项目经理）、…（可直接用这些实例 id 协作/开会/派单）`；
  pm/product 的 `[任务分派]` 提示保留（可派对象单独列）。

### B. 角色状态（后端 API + 左栏展示）

- 新路由 `GET /api/projects/:pid/agents`：合并 team + occupancy + 进行中任务 + 待处理审批/提问，返回
  `{instanceId, displayName, roleTemplateId, enabled, state: 'idle'|'working'|'meeting'|'waiting'|'disabled', sessionId?, since?, currentTask?: {id,title}}`。
  状态推导：停用 → disabled；occupancy=meeting → meeting；occupancy=working → working；有该角色待处理审批/待答提问 → waiting；否则 idle。
- 前端：`refreshPanels()` 拉取 agents；左栏团队行显示状态圆点 + 文案（空闲/工作中/会议中/等待你处理/已停用）+ 当前任务标题（hover）。

### C. PM 只协调、不产出

- `pm.yaml`：提示词强化（"不产出任何交付物；需要产出时派给对应角色并在任务中说明"）；
  移除 `artifact_submit`、`artifactTypes: []`（保留 ws_write 作为私有笔记）。
- 说明：`workdir_edit`/`cmd_run` 本就不在 pm 白名单；PM 无法写项目工作目录。

### D. 每个角色都可以发起会议

- 注册执行器工具（此前只写在模板里、未实现）：
  - `meeting_start{topic, desc, members[], agenda?}`：任意角色可调用；校验 members 存在且 enabled、不含自己；
    创建会议后**由平台代受邀 AI 成员自动接受**（→ open，占用=会议中），并在结果里返回会议 id 与参会人（用户仍可插话/拍板/结束）。
  - `meeting_close{meetingId?}`：仅主持人可结束（生成纪要）。
- 工具在 user 会话对所有角色可用（平台能力），提示词在 `[团队成员]` 后补一句"需要评审/对齐时用 meeting_start 发起会议"。

### E. 任务状态由角色自己维护

- `TaskService.setState` 规则放宽：`actor === 'user'` 或 `actor === task.assignee` 或（甲模式）协调者，均可流转；
  `done`/`terminated` 不再强制 user；保留：每角色至多 1 个 `in_progress`、终态不可回退、`done/terminated` 前结算 code 改动。
  唤醒只在"非受派者置 in_progress"时触发（避免自己唤醒自己造成回环）。
- 新工具 `task_update{taskId?, state, note?}`：默认作用于 `env.taskId`（当前激活任务），供角色汇报 开工/完成/受阻。
- UI：任务面板去掉"开工/完成/终止"按钮，改为状态徽标 + 受派者 + （hover 说明）；提示"状态由角色自行汇报，用户只查看"。

## 3. 验证

- tsc / eslint / vitest 全绿；更新 `tasks-m8b` 中旧的"done/terminated 仅 user"断言，新增
  "受派者自行置 done → 结算 code artifact""非受派者非协调者被拒""task_update 工具改状态"用例；
  新增 agents API 用例（working/meeting/waiting/idle/disabled 推导）。
- 真实模型冒烟：任意角色（如 dev）调用 `meeting_start` 发起并进入会议；角色用 `task_update` 自报完成。

## 4. 边界（本轮不做）

- 会议的议程推进/逐人发言仍由 UI 或主持人点名（`meeting_talk` 工具后续）。
- 角色状态里的 `waiting` 只覆盖"审批/提问待用户处理"；不做"等待会议开始"等更细状态。
- 任务的 `todo` 队列仍由协调者/受派者自行推进，不做自动调度器。
