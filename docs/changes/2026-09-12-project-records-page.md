# 2026-09-12 新增「项目记录」页（任务完成 / 会议完成 的卡片流）

- 需求/问题：用户要求「加入项目全局卡片：任务完成形成卡片记录、会议完成形成会议记录」。
  此前项目级没有任何"做过什么、结论是什么"的沉淀：任务只出现在右栏任务栏（活跃态为主），
  会议纪要要逐场点开，缺一个项目级的回溯视图。
- 类型：feature（新增只读页面 + 只读投影接口）
- 改动范围：`application/record`、`application/composition.ts`、`server/app.ts`、`web/`、`docs`、`tests`
- 关键文件：
  - 新增 `src/application/record/record-service.ts`：**只读投影**（不新增状态、不落盘），
    把终态任务与已结束会议合并成统一卡片，按时间倒序
  - `src/application/composition.ts`：新增 `records: RecordService`（注入 tasks + meetings.list）
  - `src/server/app.ts`：新增 `GET /api/projects/:pid/records`
  - `web/index.html`：顶栏「项目记录」按钮 + 页 3 `#records-view`
  - `web/app.js`：`showRecordsView()` / `refreshRecords()` / `renderRecords()` / `openRecordSource()` +
    `refreshRecordsIfOpen()`（任务终态、会议结束时即时刷新）
  - `web/style.css`：`.record-card` 等样式（沿用现有 `.board-summary`、`.badge` 词汇）
  - 新增 `tests/project-records-m8y.test.ts`（2 例）；`tests/static-web-m8k.test.ts` 加 1 例接线断言
  - `README.md` 工作台行补「项目记录」

## 卡片规则（用户确认：只收录任务完成 + 会议完成）

| 来源 | 收录条件 | 卡片内容 |
| --- | --- | --- |
| 任务 | `state = done` / `terminated` | 标题、受派人、状态、**完成总结/终止说明**（`resultNote`）、时间、`看会话` |
| 会议 | `state = closed` **且未被取消** | 主题、主持人、参会人、描述、结束时间、`看会议` / `看纪要` |

- 一键跳源：任务 → 受派人 user 会话；会议 → 会议会话（并可选把纪要渲染到右栏「记忆/纪要」）。
- 入口：进入项目后顶栏出现「项目记录」；切页不重建项目上下文、不断开 WS。
- **返回入口（用户反馈补充）**：记录页页头有「← 返回工作台」（回到当前会话；无会话时回该项目第一个角色会话）；
  顶栏「项目记录」按钮**再次点击也返回工作台**（同一入口来回切换）；卡片上的「看会话/看会议」跳源后同样回工作台。

## 顺带修复（同一需求暴露的语义 bug）

`MeetingService.cancel()` 与 `close()` 都写 `closedAt` 且都置 `state='closed'`，导致**被取消的会议
会被当成"完成"**（会议列表的「已结束」也一直混着取消项，无法区分）。现在 cancel 额外写
`meeting.canceledAt`，项目记录据此把取消的会议排除在完成记录之外。

## 行为变化

- 新增只读接口 `GET /api/projects/:pid/records`（返回 `{ records: ProjectRecordCard[] }`）。
- 新增前端页 3（项目记录）与顶栏入口；其余页面/接口不变。
- 会议 meta 新增可选字段 `meeting.canceledAt`（取消时间；旧数据无此字段 = 正常结束）。

## 验证

- 新增 `tests/project-records-m8y.test.ts`：
  ① 只收录 done/terminated 任务与 closed 会议（进行中任务、未结束会议、**被取消的会议**都不收录）、
    完成总结与来源会话正确、按时间倒序；② 空项目返回空数组。
- `tests/static-web-m8k.test.ts` 新增 1 例：`#records-view`/`#records-list`/`btn-records`/`btn-records-back` 存在，
  `showRecordsView`/`showWorkbenchView`/`refreshRecords`/`renderRecords`/`openRecordSource`/`refreshRecordsIfOpen` 接线未断，
  `.record-card` 样式存在。
- 全量：`npm run test` → **39 files / 224 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 返回入口补充后复验：`static-web-m8k` + `project-records-m8y` 8 例通过；全量 39 files / 224 tests 全绿。
- 测试：新增 `tests/project-records-m8y.test.ts`

## 已知边界

- 记录页是**只读投影**：不落盘、不引入新状态；任务/会议数据被物理删除时记录随之消失。
- 会议卡片不含纪要正文（卡片只放主题/描述/参会人），纪要按 `看纪要` 现拉。
