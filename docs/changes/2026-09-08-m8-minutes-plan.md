# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M6/M3 补充：纪要转任务一步化（D17-⑦）+ plan-execute 落 plan 事件

- 需求/问题: 继续整体开发目标：① 会议纪要内待办「勾选即建」为任务（D17-⑦：标题=待办摘要、受派者预填可改、来源挂本会议、creator=user）；② plan-execute 回合在 turn_start 后落 `plan` 事件（data-storage §4.2 断点/进度依据）。
- 类型: 代码(扩展) + 测试
- 改动范围:
  1. `src/application/meeting/meeting-service.ts`：`createTaskFromMinutes(projectId, meetingId, {title?, assignee})`——closed 校验、desc 附纪要正文与来源会议、经注入的 taskCreate（creator=user）建任务；REST `POST /meetings/:mid/minutes/tasks`。
  2. `src/application/composition.ts`：MeetingService 注入 taskCreate（闭包引用后续声明的 tasks，延迟调用无 TDZ 问题）。
  3. `src/application/agent-loop/loop-runner.ts`：实例 loop.strategy=plan-execute 时，turn_start 后 append `plan` 事件（turnId/planId/steps[1]/stepIndex/status=executing）并广播（先盘后推）。
  4. `tests/minutes-plan-m8e.test.ts`：2 用例（closed 纪要转任务→title/creator=user/assignee/sessionId=mid/desc 含主题；未结束 409；plan-execute 回合 log 出现 plan(executing,steps) 且含 turn_end）。
- 原因: 会议产出→任务链条闭环（纪要派生视图直接生成受派任务），并让 plan-execute 具备断点恢复的日志基础。
- 行为变化: closed 会议纪要可一键转任务；dev 等 plan-execute 角色回合落 plan 事件（日志真相源含进度，供未来断点续跑）。
- 验证: `npm run test` 107/107；tsc/eslint 0 错。
- 测试: minutes-plan-m8e 2 用例。
- 遗留(说明): 纪要「勾选即建」的批量多待办 UI 与待办归属解析仍留前端；plan 事件驱动的断点续跑（读最近 plan + 摘要尾部续做）在真实模型/用户触发路径启用（跨重启不自动续跑语义见 agent-runtime §7/memory §6）。
