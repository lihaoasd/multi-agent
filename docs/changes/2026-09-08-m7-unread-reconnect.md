# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M7 补充：工作台未读/已读回执 + 断线重连 + 会议 UI 按钮

- 需求/问题: 继续整体开发目标：补齐工作台会话未读（contract WS ack / sessions unread）、打开即已读、断线重连，以及会议「点名发言/纪要重新生成」的 UI 入口。
- 类型: 代码(扩展) + 测试
- 改动范围:
  1. 服务端未读：`SessionService` 会话 meta 增加 `readSeq`（投影，随 meta 落盘）；`listSessions`/`getSession` 附 `unread = lastSeq - readSeq`（MVP 单用户口径）；新增 `markRead` + REST `POST /api/projects/:pid/sessions/:sid/read {seq}`（已读回执，seq 只增不回退）。
  2. 前端 `web/app.js`：
     - 会话列表未读徽标（每次其它会话事件刷新列表）；
     - 打开会话渲染后提交已读回执（未读清零）、记录 seenSeq 锚点；
     - WS 断线指数退避自动重连（1s→2s→…→8s 上限）；
     - 会议面板：open 状态「点名成员发言」按钮；closed 状态「查看纪要 + 重新生成纪要」按钮。
  3. `tests/unread-m7b.test.ts`：2 用例（新消息→unread>0；read 回执→unread=0 且列表持久；详情含 unread/readSeq）。
- 原因: M7 工作台完善项落地（未读/重连/纪要重生成 UI）。
- 行为变化: UI 会话列表显示未读数；打开会话即清零；断线自动重连；会议可直接点名成员发言与重生成纪要。
- 验证: `npm run test` 102/102；tsc/eslint 0 错；冒烟（3104）：GET / 200、聊天后 unread=4、read 回执后 unread=0。
- 测试: unread-m7b 2 用例。
- 遗留(说明): 多用户未读隔离、增量拉取(log?fromSeq 已具备但 UI 未做断点续传滚动)与 Web Notification 为后续。
