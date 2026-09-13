# 2026-09-12 会议与「等待你处理」的冲突处理（入会搁置 + 散会回注 + 开场门）

- 需求/问题：角色可能同时处于「等待你处理」（待答提问卡片 / 待批审批）与「被拉进会议」。
  原实现无规则——`meeting_start` 无脑代所有受邀 AI 成员 accept 并占 `meeting`，后台链随即点名该成员发言：
  徽标「会议中」而卡片仍挂着、被点名却无法开工（回合被 standby 跳过）、主持人收尾后会议自动 close，
  该成员永远没机会发言，会后也没有任何回注。
- 类型：feature（含行为变更）
- 改动范围：`application/meeting`、`application/question`、`application/approval`、`application/tools`、
  `application/composition.ts`、`docs`、`tests`
- 关键文件：
  - 新增 `src/application/meeting/shed-store.ts`：搁置清单（`meeting-shed.jsonl`，可重建）
  - `src/application/question/question-service.ts`：新增 `cancelPending()`（pending/queued → cancelled + 推 `question.answered`）
  - `src/application/approval/approval-service.ts`：新增 `expirePending()`（pending → expired + 审计投影）
  - `src/application/meeting/meeting-service.ts`：`respond(accept)` 触发入会搁置 `onShed`；`close()` 触发散会回注 `onClosed`；
    新增 `recordHold()`（开场门记录）
  - `src/application/tools/service-tools.ts`：`meeting_start` 后台链新增开场门 `meetingReady`（未就绪记 hold 事件）
  - `src/application/composition.ts`：注入 `onShed`/`onClosed`/`meetingReady`；新增 `meetingWrapUpText()`
  - 新增 `tests/meeting-shed-m8x.test.ts`（2 例）
  - 方案 `docs/plan/2026-09-12-meeting-vs-waiting-conflict.md`；`README.md` 会议/团队状态口径

## 定稿语义（用户 2026-09-12 确认）

1. **会议中优先**：受邀入会即压下「等待你处理」；
2. **入会搁置**：该角色的待答提问**作废**、待批审批**一并作废**（卡片消失、待办条清空）；
3. **等全员入会后**主持人再开场发起讨论；
4. **散会回注 + 自动续跑**：把「会议纪要 + 入会时被搁置的事项」写回每个参会者的 user 会话并唤醒一轮，
   让角色带着会议结论继续推进任务。

## 行为变化

- 角色被邀请入会时：其 pending 提问置 `cancelled`（推 `question.answered`，前端撤卡片，**前端无需改动**）、
  pending 审批置 `expired`（不可再批准/拒绝），并留档到 `meeting-shed.jsonl`。
- 主持人开场前，平台确认受邀成员均已入会且无待处理项；未就绪则记一条 `meeting_event(action='hold')` 便于追溯
  （仍照常推进，避免整场会议无限期卡住）。
- 会议关闭（含主持人 `meeting_close` 与平台自动收尾）后，每个参会者的 user 会话收到一条系统消息
  （【会议结论】纪要 + 【入会时被搁置的事项】作废清单 + 继续推进指令）并**自动唤醒一轮**。
- 会议/审批/提问的状态机枚举未变；接口与 WS 事件未新增（复用 `question.answered`）。

## 验证

- 新增 `tests/meeting-shed-m8x.test.ts`（2 例）：
  ① 受邀成员带待答提问+待批审批入会 → 提问 cancelled / 审批 expired / 撤卡片推送 / 徽标 `meeting` /
     开场无 hold 事件；
  ② 散会后每个参会者会话收到【会议结论】系统消息、搁置清单写入正文、且回注后确实跑了一轮（turn_start）。
- 回归：`meeting-m6`、`meeting-round-m6b`、`minutes-plan-m8e`、`attention-m8d`、
  `agent-state-waiting-m8w`、`team-status-m8i` 全绿。
- 全量：`npm run test` → **38 files / 221 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 测试：新增 `tests/meeting-shed-m8x.test.ts`

## 已知边界

- 被搁置的提问/审批**不会再有用户答复**（用户选择"作废"）：角色拿到的是"它当初在等什么"的清单，
  需要重新拍板时由它重新 `ask_user`（回注正文已明确要求）。
- 开场门是"记录 + 照常推进"而非"无限等待"：若成员在搁置后又被新工作阻塞，会议仍会推进，该成员由散会回注兜住。
