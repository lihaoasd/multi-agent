# 会议与「等待你处理」的冲突处理（2026-09-12，已实现）

> 状态：已按用户 2026-09-12 确认的语义实现，见 `docs/changes/2026-09-12-meeting-vs-waiting-conflict.md`。
> 实现验证：`tests/meeting-shed-m8x.test.ts` 2 例通过；全量 38 files / 221 tests 全绿。

## 一、问题

角色可能同时处于两种状态：

- **等待你处理**：有待答提问（ask_user 卡片）或待批审批（高危命令）；
- **被拉进会议**：被 `meeting_start` 邀请，平台代其接受并占用 `meeting`。

现在的实现没有规则，两个来源各按各的来：`meeting_start` 无脑代所有 AI 成员 accept 并占 `meeting`，
随后后台链立刻让该成员发言；而刚修的 standby 逻辑又不让"等待中"的角色开工。结果：

- 徽标显示「会议中」，会话里却还挂着一张卡片（状态叠加，用户无法判断该先做什么）；
- 该成员被点名却没法发言（回合被跳过），主持人收尾后会议**自动 close** → 这个成员永远没机会发言；
- 会后没有任何回注，角色不知道"我有个问题被搁置了"，任务卡在原地。

## 二、定稿语义（用户 2026-09-12 确认）

| 决策 | 结论 |
| --- | --- |
| 优先级 | **会议中优先**：一入会就压下等待（徽标「会议中」） |
| 卡片去向 | **待答提问作废、待批审批一并作废**（卡片从会话与待办条消失） |
| 会议开场 | **等全员入会后**，主持人再开场发起讨论 |
| 会后继续 | 散会时把**会议纪要 + 被作废的事项**自动回注该角色并**自动续跑一轮**，它据此继续执行任务 |
| 恢复方式 | 自动（平台触发，不需要用户再点一下） |

一句话：**入会即清空"等待你处理"，会中不许开工；散会后带着会议结论与作废清单把它唤醒继续做。**

## 三、设计

### 3.1 入会搁置（shed）

新增 `application/meeting/shed-store.ts`（`meeting-shed.jsonl`，纯文件、可重建）：

```ts
interface ShedRecord { id; projectId; meetingId; instanceId; at;
  questions: Array<{ id; question }>;      // 被作废的待答提问
  approvals: Array<{ id; summary }>;       // 被作废的待批审批
}
```

`MeetingService` 在成员**接受邀请**（`respond(accept)`，即 `onOpen` 之前）时调用注入的 `shedForMeeting` 钩子：

1. `questions.cancelPending(projectId, sessionIds, reason)`：pending/queued → `cancelled`，落盘并推 `question.answered`
   （前端据此撤下卡片——复用已有事件，**不改前端**）；
2. `approvals.expirePending(projectId, actor)`：pending → `expired`（服务已支持该状态，审核侧不再可决定）；
3. 写一条 `ShedRecord`（会议结束回注用）。

> 卡片消失 = 提问置 `cancelled` + 推 `question.answered`；待办条由 `AttentionService` 按 pending 过滤，自动随之消失。

### 3.2 等全员入会再开场

`service-tools.ts` 的 `meeting_start` 后台链改为：

```
建会（proposed） → 逐个 respond(accept)（含搁置）
  → 只有当 members ∈ accepted 且全部"可用"（无 pending 提问/审批）才 runMeetingTurn(host, 开场)…
  → 否则 append 一条 meeting_event(action='hold', waiting:[...])（会议保持 open，不推进、不自动 close）
```

同一套判定也用于主持人的开场回合：平台在开场前再查一次（`meetingHolds()`），有人被搁置就直接 hold，
让主持人（及成员）在解除后自动补跑——复用本方案 3.4 的"回注续跑"。

### 3.3 状态口径

- `deriveAgentState` 保持 `meeting > waiting > working > idle` 的现状口径（会议中优先，符合本次决策）；
- 由于入会即搁置，正常情况下不会再出现"会议中 + 卡片"；
- **不改**上一轮修复的 standby 规则（等待你处理期间不开工）——它约束的是"带卡片时被唤醒"，
  与本方案的"入会搁置"是互补的：卡片在 → 不开工；入会 → 卡片作废，于是可以开工。

### 3.4 散会回注 + 自动续跑

`MeetingService.close()` 已有 `onClose(pid, meetingId)` 钩子（现由组合根注入）。改为：

```
close → 对每个参与者（主持人 + 成员）：
  读该会议的 ShedRecord（可能为空）
  → sendUserMessage(u_<iid>, 【会议结论】纪要摘要 + 【会前被你搁置的事项】作废清单
       + "请据此继续推进你的任务；如仍需拍板请重新提问")
  → wake 一轮（sendUserMessage 自带）
```

即：`runAgentTurn(meeting)` 之外，再给**每个参与者**的 user 会话注入一条系统消息并唤醒，
沿用既有"系统消息 + 唤醒一轮"机制（`TaskService.notifyClaim` 同款），无需新调度器。

### 3.5 不做

- 不做"会议期间把搁置项挂到会议窗口顶部"（本次选择作废 + 会后回注）；
- 不做手动"继续会议"按钮（本次选择自动续跑）；
- 不改会议状态机枚举（仍 queued/proposed/open/blocked_waiting_user/closed）。

## 四、改动范围

| 文件 | 改动 |
| --- | --- |
| `src/application/question/question-service.ts` | 新增 `cancelPending()`（按会话/角色批量作废 + 推送） |
| `src/application/approval/approval-service.ts` | 新增 `expirePending()`（pending → expired + 审计投影） |
| `src/application/meeting/shed-store.ts`（新增） | 搁置清单落盘（会后回注依据） |
| `src/application/meeting/meeting-service.ts` | `respond(accept)` 触发搁置钩子；`close()` 触发回注钩子；hold 判定 |
| `src/application/tools/service-tools.ts` | `meeting_start` 后台链：等全员入会再开场；hold 时不自动 close |
| `src/application/composition.ts` | 注入搁置/回注钩子（questions/approvals/sessionService） |
| `tests/meeting-shed-m8x.test.ts`（新增） | 入会作废卡片 + 会后回注续跑 + 全员入会才开场的回归 |
| `README.md` / 修改记录 | 口径与改动记录 |

## 五、验证

- 新测试覆盖：① 带待答提问/待批审批的角色被邀请 → 卡片消失（`question.answered` 推送 + pending 归零）、
  审批变 expired、徽标=会议中；② 有成员被搁置时会议**不自动 close**；③ 散会后该角色 user 会话收到
  「会议结论 + 搁置事项」系统消息并跑了一轮（用 Mock/脚本化 gateway 断言）。
- 回归：`meeting-m6`、`meeting-round-m6b`、`minutes-plan-m8e`、`attention-m8d`、
  `agent-state-waiting-m8w`、`ask-user-suspend-m8t`、`approval-blocking-m8v` 全绿。
- 全量 `npm run test` / `typecheck` / `lint` / `build`。

## 六、已确认并落地

1. 「等全员入会」的"可用" = **受邀成员均已 accept 且无 pending 提问/审批**；未就绪时记 `meeting_event(action='hold')`
   并照常推进（不无限期卡住整场会议）。
2. 会后回注包含**被作废的提问题干与审批摘要**（角色知道当初在等什么），不含完整参数。
