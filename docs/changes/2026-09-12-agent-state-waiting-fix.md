# 2026-09-12 修复：角色「工作中」与 ask 卡片同时出现（状态推导单点化）

- 需求/问题：用户反馈——左栏团队行显示角色**工作中**，其会话里同时摆着一张**待回答的提问卡片**（ask_user）。
- 类型：bug-fix
- 改动范围：`application`（运行态推导 / agent loop / 组合根）、`server`（agents 查询接口）、`docs`、`tests`
- 关键文件：
  - 新增 `src/application/runtime-state.ts`：`AgentRuntimeState` + `deriveAgentState()`（纯函数，状态推导单点）
  - `src/server/app.ts`：`GET /api/projects/:pid/agents` 改用 `deriveAgentState`
  - `src/application/agent-loop/loop-runner.ts`：回合开始前判「等待你处理」→ 不开工；回合结束广播走单点推导
  - `src/application/composition.ts`：注入 `toolRuntime.runtimeState`（读该角色 pending 提问/审批）
  - 新增 `tests/agent-state-waiting-m8w.test.ts`（2 例）
  - 新增方案 `docs/plan/2026-09-12-agent-state-waiting-fix.md`；`README.md` 团队状态行补口径

## 原因（根因）

状态有**两个推导来源**且优先级不一致：

1. `GET /agents`：`disabled > meeting > working(occupancy) > waiting(待批审批/待答提问) > idle`；
2. loop 回合：开始无条件 `occupancy.acquire(..., 'working')` 并广播 `working`，结束只按 occupancy 广播。

于是只要「角色已有待答提问时又被触发一个回合」（任务/审批/任务完成的系统消息走 `sendUserMessage`、
会议点名走 `runAgentTurn` 都会触发），左栏就被广播成 `working`，而卡片仍在等用户；
`GET /agents` 的 `working` 又压过 `waiting`，使"工作中 + 卡片"这一自相矛盾的状态被固化。

## 行为变化

- 角色有待答提问 / 待批审批（且不在会议中）→ 一律显示「等待你处理」，且**不再被算作开工**。
- 这种状态下收到唤醒（系统消息/任务通知）：**消息仍落盘**（不丢），但**不占 occupancy、不调模型、不开工**；
  用户答复后由下一回合带着该消息继续（不新增补跑机制）。
- 会议中的角色不受影响（仍显示「会议中」）；`GET /agents` 的既有语义（disabled/meeting/waiting/working/idle）不变。
- 无公开接口/数据结构变更（`agent.state` WS 载荷字段不变）。

## 验证

- 新增回归（修复前两例均失败于"广播了 working"，修复后通过）：
  `npx vitest run tests/agent-state-waiting-m8w.test.ts` → 2 passed。
- 相关回归：`team-status-m8i`（8）、`ask-user-suspend-m8t`（5）、`approval-blocking-m8v`（4）、
  `question-ws-push-m8l`（3）全绿。
- 全量：`npm run test` → **37 files / 219 tests passed**；`npm run typecheck`、`npm run lint`、
  `npm run build` 均通过。
- 测试：新增 `tests/agent-state-waiting-m8w.test.ts`

## 已知边界

- 等待期间被丢弃的是"这一轮开工"，不是消息：消息已落盘，用户答复或后续消息触发回合时会被读到。
