# 2026-09-09 移除「未读红点」功能（前端）

> 类别：changes · 需求来源：用户表示"不需要这个功能"（团队行上的红色未读徽标）

## 改动（仅前端）

- **移除团队行/会议行的未读红标**（`renderTeamNav()` / `renderMeetingsNav()` 里 `unread > 0` 的 `.badge`）。
- **移除读回执**：打开会话不再 `POST /sessions/:sid/read`，去掉 `current.seenSeq` 记账。
- **移除未读刷新链路**：删除 `refreshUnread()` 与 `scheduleRefreshUnread`（合并调度器只剩面板与角色状态两个）。
- **默认会话改为约定推导**：不再拉 `/sessions` 列表，直接打开第一个角色的 `u_<instanceId>`；
  团队行点击也直接 `openSession(u_<iid>)`（不再做"该角色有没有会话"的兜底查询）。
- **WS 其它会话事件直接忽略**（原先只为刷新未读徽标而处理）。

## 副作用（正面）

前端**完全不再调用 `GET /projects/:pid/sessions`**（此前请求风暴的最后一个来源）——
现在每个项目只剩：打开时拉一次 panel 数据、面板按需刷新、角色状态 5s 轮询（`/agents`）。
`web/app.js` 里保留的 `/sessions/...` 仅剩：会话详情 `GET /sessions/:sid`、发消息 `POST /sessions/:sid/messages`、
翻页 `GET /sessions/:sid?beforeSeq=`（都是必要的单会话接口）。

## 保留（未删）

后端 `GET /projects/:pid/sessions`（列表 + unread）、`POST /sessions/:sid/read`、
`SessionService.listSessions/markRead` 仍保留，且有 `tests/unread-m7b.test.ts` 覆盖；
它们不再被前端调用，属于"可选能力"。如需连后端一起删除（同时移除该测试），可再执行一次。

## 验证

- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **147 用例全绿**。
- grep 确认 `web/app.js` 中已无 `unread` / `current.sessions` / `seenSeq` / `/read` 残留；
  WS 处理其它会话事件分支为空（不产生 HTTP）。

## 说明

右上角「需你处理 N」红标**保留**（那是待批审批 + 待答提问 + 会议拍板的待办数，与未读无关）。
