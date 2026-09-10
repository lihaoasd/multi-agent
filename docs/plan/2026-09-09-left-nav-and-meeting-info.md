# 开发方案：侧栏「团队 / 会议」分离 + 会议主题描述与参会人 + 停用角色修复 · 2026-09-09

> 需求来源（用户口述）：
>
> 1. 左边栏把「团队」和「会话」分开：点团队 = 和每个人的一对一会话；原会话区改成「会议」，所有会议出现在这里。
> 2. 申请开会的人要定**会议主题**与**会议描述**，显示在会话窗口顶部。
> 3. 会议中要显示**参会人员**，显示在会话窗口顶部。
> 4. 无法停用角色。

## 1. 现状

- 左栏：`团队`（成员 + 停用/启用按钮）+ `会话`（user 与 meeting 会话混在一起）。
- 右栏「会议」区：一个写死主题的「发起会议(评审)」按钮 + 全部会议列表与控制按钮。
- 会话窗口顶部只有一行标题（`sessionLabel + 状态`），没有会议描述/参会人。
- 会议 meta 只有 `topic`，没有 `desc`；创建接口 `POST /meetings {host,topic,agenda,members}`。
- 停用：后端 `DELETE /projects/:pid/team/:iid` → `enabled=false`（有测试覆盖）；前端团队行有「停用」按钮，
  但点击无确认、错误静默、且停用后会跳走会话，用户感知为"无法停用"。

## 2. 改动范围

### A. 后端：会议描述

- `meeting-service.ts`：`MeetingRecord.meeting.desc?: string`、`CreateMeetingInput.desc?: string`，
  `create()` 落库 `desc`（trim），`create` 会议事件 payload 带上 `desc`。
- `app.ts`：`POST /api/projects/:pid/meetings` body 增加 `desc?` 并透传。
- 测试：`tests/meeting-m6.test.ts` 增加"主题+描述落盘并在详情/列表返回"断言。

### B. 左栏分区

- `index.html`：左栏改为两个区：
  - 「团队」(`#team-list`)：一行一个成员 = 与他的**一对一会话**入口（点击打开 `u_<iid>`），
    行内显示未读徽标、停用标记与「停用/启用」按钮；
  - 「会议」(`#meeting-nav-list`)：**全部会议**列表（主题 + 状态 + 未读），点击打开该会议会话；
    区头「＋发起」按钮打开发起会议弹窗。
- `app.js`：删除 `renderSessions()`，改为 `renderTeam()`（1:1 导航）+ `renderMeetingsNav()`（会议导航）；
  `openSession()`/`refreshUnread()`/`reloadProjectView()` 相应改为重渲染这两块。
- 停用/启用：按钮 `stopPropagation()`（避免触发行点击进会话）+ 停用二次确认 + 失败提示；
  停用后**保持当前会话**（不再跳走），并在打开停用成员会话时禁用输入框并提示。

### C. 发起会议（主题 + 描述 + 参会人）

- 新增弹窗 `#meeting-modal`：主持人（下拉）、主题（必填）、会议描述（必填）、议题（可选，一行一个）、
  参会成员（多选，不含主持人，至少 1 人）。
- 创建成功 → 刷新面板 → 直接进入新会议会话。

### D. 会话窗口顶部（会议信息）

- `index.html`：`#session-header` 增加 `#session-sub`（会议时显示）。
- 会议会话顶部显示：
  - 标题：`会议 · <主题>` + 状态徽标；
  - 描述行：`描述：…`；
  - 参会行：`主持人 X`、`参会：Y（已接受/待回应/稍后/已拒绝）`、`我（用户）`。
- 用户会话：`#session-sub` 隐藏（保持原有标题）。

### E. 右栏「会议」→「当前会议」

- 右栏只展示**当前打开会议**的状态与控制（接受邀请/请求拍板/点名发言/结束/纪要/转任务），
  不再重复整份列表；未打开会议时提示去左栏选择或发起。

## 3. 验证

- `npx tsc`、`npx eslint .`、`npx vitest run --pool=threads` 全绿（含新增会议描述用例）。
- 起服务实测：创建项目 → 发起带主题/描述的会议 → `GET /meetings` 与 `GET /sessions/:mid` 均含 `desc`；
  `DELETE /team/:iid` 后 team 中该成员 `enabled=false`，`PATCH {enabled:true}` 可恢复（脚本验证）。
- 静态资源校验：`/index.html`、`/app.js`、`/style.css` 含新结构（团队/会议分区、会议弹窗、会话头副行）。

## 4. 边界（本轮不做）

- 会议描述不注入模型上下文（仅展示与纪要来源信息）。
- 不支持会议改期/编辑主题；发起后仅可按现有状态机推进。
- 前端仍无浏览器 e2e，交互以静态校验 + API 实测验证。
