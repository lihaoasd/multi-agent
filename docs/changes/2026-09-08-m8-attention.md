# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M7/M8 补充：「需你处理」待办聚合（D17-③）+ 启动会议槽位恢复

- 需求/问题: 继续整体开发目标：① 阻塞级「需你处理」待办条的服务端聚合（会议拍板 / 审批；D17-③，不引入第二份状态——解除=原处操作后自动消失）与 UI 角标；② 启动自检恢复会议排队槽位（queued→proposed，重启无损 data-storage §9）。
- 类型: 代码(新建/扩展) + 测试
- 改动范围:
  1. `src/application/attention/attention-service.ts`：AttentionService.list(projectId) → 聚合 pending approvals（kind=approval）与 blocked_waiting_user 会议的 pending 决策点（kind=meeting，含问题与主持人），按 at 排序。
  2. `src/server/app.ts`：GET /api/projects/:pid/needs-attention。
  3. `src/application/composition.ts`：注入 attention。
  4. `src/server/index.ts`：监听后异步 `restoreOnBoot`——遍历全部项目调 `meetings.promoteQueuedIfFree`（重启后排队会议自动补位，幂等）。
  5. `web/`：顶栏「需你处理」角标（角标=attention 数量；审批/会议操作后随 refreshPanels 刷新）。
  6. `tests/attention-m8d.test.ts`：2 用例（会议阻塞拍板→待办出现→答复→消失；无待办为空数组）。
- 原因: D17-③ 顶部待办条第一优先级的服务端语义与最小 UI 落地。
- 行为变化: 阻塞级事项（会议拍板/审批）聚合为统一待办源，UI 顶栏角标随处理即时消失；服务重启自动恢复排队会议占槽。
- 验证: `npm run test` 105/105；tsc/eslint 0 错。
- 测试: attention-m8d 2 用例。
- 遗留(说明): 待办条「原地操作」的完整 UI（在角标处直接批准/拍板）与通知横幅为前端后续；占用重建的完整自检（session log 对账 occupancy）沿用 runtime.state 基线与 reconcileLastSeq 语义，调度恢复已覆盖会议排队。
