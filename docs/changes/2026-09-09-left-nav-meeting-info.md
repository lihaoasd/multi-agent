# 2026-09-09 侧栏「团队/会议」分离 + 会议主题描述与参会人 + 停用角色修复

> 类别：changes · 需求来源：用户「左边栏团队和会话分开，点团队就是和每个人的会话；原会话改成会议；
> 申请开会的人要定主题和描述；会议中显示参会人员；无法停用角色」。方案见
> [docs/plan/2026-09-09-left-nav-and-meeting-info.md](../plan/2026-09-09-left-nav-and-meeting-info.md)

## 改动范围

### A. 左栏：团队 / 会议 分区

- `web/index.html`：左栏改为「团队」(`#team-list`) + 「会议」(`#meeting-nav-list`) 两区，
  删除原「会话」列表 (`#session-list`)；会议区头新增「＋发起」按钮 (`#btn-new-meeting`)。
- `web/app.js`：
  - `renderTeam()` → **`renderTeamNav()`**：一行一个成员 = 与他的**一对一会话**入口（点击打开 `u_<iid>`），
    行内显示未读徽标、`已停用` 标签与「停用/启用」按钮；
  - 新增 **`renderMeetingsNav()`**：左栏列出**全部会议**（主题 + 状态徽标 + 未读），点击进入会议会话；
  - 删除 `renderSessions()`；`openSession()`/`refreshUnread()`/`refreshPanels()`/`reloadProjectView()` 相应改为刷新两个导航区。

### B. 发起会议：主题 + 描述 + 参会人

- 新增弹窗 `#meeting-modal`：主持人（下拉，仅已启用角色）、**会议主题（必填）**、**会议描述（必填）**、
  议题（可选，一行一个）、参会成员（多选，不含主持人，至少 1 人）。
- 新增 `openMeetingModal()` / `renderMeetingMemberPicker()` / `createMeetingFromModal()`；
  创建成功 → 刷新面板 → 直接进入新会议会话。
- 后端：`MeetingRecord.meeting.desc?` 与 `CreateMeetingInput.desc?` 落库（trim），
  `create` 会议事件 payload 带 `desc`；`POST /api/projects/:pid/meetings` body 增加 `desc` 透传。

### C. 会议会话窗口顶部

- `web/index.html`：`#session-header` 内新增副行 `#session-sub`。
- `web/app.js` 新增 `renderSessionHeader(meta)`：会议会话顶部显示
  `主题 + 状态徽标`、`主持人`、`描述`、`参会人员`（主持人 / 各成员的回应状态：已接受·稍后·已拒绝·待回应 / 我）；
  用户会话隐藏副行，标题保持原名。

### D. 停用角色

- 「停用/启用」按钮加 `stopPropagation()`（不再误触发行点击进入会话）、停用前二次确认、失败提示带原因。
- 停用后**保持当前会话**（`reloadProjectView({keepSession:true})`，不再跳走）。
- 打开已停用成员的会话：输入框与发送按钮禁用并提示「该角色已停用，仅可查看历史」；
  `setSendBusy()` 不再把禁用态打开，`sendMessage()` 前置拦截。

### E. 右栏「会议」→「当前会议」

- 右栏只展示**当前打开会议**的状态与控制（接受邀请/请求拍板/点名发言/结束/纪要/转任务），
  不再重复整份会议列表；未打开会议时提示去左栏选择或发起。

## 关键文件

`src/application/meeting/meeting-service.ts`、`src/server/app.ts`、`tests/meeting-m6.test.ts`、
`web/index.html`、`web/app.js`、`web/style.css`、`docs/plan/2026-09-09-left-nav-and-meeting-info.md`。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **127 用例全绿**
  （`tests/meeting-m6.test.ts` 增补"主题 + 描述落盘并可从会话详情读回"断言）；`npx prettier --check` 前端文件通过。
- 真实服务实测（脚本，跑完即删）：
  - 发起会议带主题+描述 → `POST /meetings` 返回 `topic/desc`，`GET /meetings` 与 `GET /sessions/:mid`
    均含 `topic/desc/host/members`（顶部展示数据就绪）；
  - `DELETE /team/:iid` → team 中该成员 `enabled=false`；`PATCH {enabled:true}` → `enabled=true`（停用真的生效并可恢复）；
  - 静态资源实测：`/` 含 `team-list`/`meeting-nav-list`/`meeting-modal`/`session-sub`，旧的 `session-list` 已移除；
    `/app.js` 含 `renderTeamNav`/`renderMeetingsNav`/`openMeetingModal`/`renderSessionHeader`/`stopPropagation`。

## 遗留（说明）

- 会议描述仅用于展示与人工阅读，不注入模型上下文，也不写入纪要正文（后续可加）。
- 会议发起后不支持编辑主题/描述或改参会人；仅按现有状态机推进（接受→进行→拍板→结束）。
- 前端仍无浏览器 e2e：交互以「静态资源校验 + API 实测 + 代码审查」验证，未做真实点击回归。
- 停用中的角色不会被加入新会议（发起弹窗仅列已启用角色）。
