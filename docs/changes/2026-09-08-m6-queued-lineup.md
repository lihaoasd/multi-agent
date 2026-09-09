# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M6 补充：queued 自动转 proposed + 阵容聚合消息

- 需求/问题: 继续整体开发目标：补齐会议槽位调度（D16-① 槽空自动转 proposed，含取消/结束场景）与成员阵容聚合消息（D17-② 不逐条打扰：谁在会/稍后/拒绝一条推送）。
- 类型: 代码(扩展) + 测试
- 改动范围:
  1. `src/application/meeting/meeting-service.ts`：
     - `promoteQueuedIfFree`：无占槽会议时把最早的 queued 会议自动转 proposed（落 meeting_event promote_queued）；close/cancel 后调用 → 排队不残留；
     - `emitLineup`：每次成员 respond 后把 memberDecisions 聚合成一条 `lineup` 事件（accepted/later/declined 数组）。
  2. `tests/meeting-m6.test.ts`：扩展 2 用例（占槽 queued → 结束首个 open 会议 → 自动转 proposed；dev later + qa accept → lineup 聚合 accepted=[qa]/later=[dev]）。
- 原因: M6 队列语义闭环（D16-①/D17-② 通知分级落地为事件）。
- 行为变化: 会议结束/取消后排队会议自动补位 proposed；成员决定以聚合 lineup 事件推送（会话日志真相源）。
- 验证: `npm run test` 103/103；tsc/eslint 0 错。
- 测试: meeting-m6 扩至 6 用例。
- 遗留(说明): 「重启后占槽重建」依赖启动自检扫描（占用槽以 runtime.state occupancy 为基线，meeting meta 全量落盘已具备，重启扫描器可后续加）；阵容推送的 UI 呈现与通知分级（强通知横幅/待办条）留前端后续。
