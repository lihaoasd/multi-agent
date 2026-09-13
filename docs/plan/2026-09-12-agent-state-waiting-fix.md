# 「角色工作中却有 ask 卡片」修复方案（2026-09-12）

## 一、需求与现象

- 用户反馈：左栏团队行显示角色**工作中**，会话里同时摆着一张**待回答的提问卡片**（ask_user）。
- 期望：两者互斥。角色有待答提问（或待批审批）时，状态必须是「**等待你处理**」；
  按文档语义（`docs/design/agent-runtime.md` §2），进入 waiting 的角色**不应再开工**。

## 二、根因（沿调用链定位）

状态有**两个推导来源**，且优先级不一致：

1. `GET /api/projects/:pid/agents`（`src/server/app.ts`）：
   `disabled > meeting > working(occupancy) > waiting(有待批审批/待答提问) > idle`。
2. WS `agent.state`（`src/application/agent-loop/loop-runner.ts`）：
   回合开始无条件 `occupancy.acquire(..., 'working')` 并广播 `working`；回合结束只按 occupancy 广播。

于是只要「已有待答提问时又被触发一个回合」，就会出现「工作中 + 卡片」：

- 触发来源真实存在：任务/审批/任务完成等系统消息走 `SessionService.sendUserMessage`；
  会议点名走 `runAgentTurn`。角色带着未回答的提问被唤醒后，只会再次 `ask_user`（软挂起/排队），
  于是左栏被广播成 `working`，而卡片仍在等用户。
- 更糟的是：`GET /agents` 的优先级也让 occupancy 压过 waiting，所以 `working` 期间**任何**有待答提问的
  角色都会显示工作中——即使它并没有真的在干活。

### 复现（先失败后修复）

`tests/agent-state-waiting-m8w.test.ts`：

- 造一条 pending 提问（或一条 pending 审批）→ `GET /agents` 为 `waiting`；
- 调 `sendUserMessage`（系统消息唤醒）→ 现状广播 `agent.state = working`（断言失败）。

## 三、改动范围

| 文件 | 改动 |
| --- | --- |
| `src/application/runtime-state.ts`（新增） | 状态推导**单点**：`AgentRuntimeState` + `deriveAgentState()`（纯函数） |
| `src/server/app.ts` | `GET /agents` 改用单点推导（消除重复实现） |
| `src/application/agent-loop/loop-runner.ts` | ① 回合开始：有待答提问/待批审批 → **不开工**（不占 occupancy、不跑模型）；② 回合结束广播的状态走单点推导 |
| `src/application/composition.ts` | 注入 `runtimeState` 钩子（读 pending 提问/审批） |
| `tests/agent-state-waiting-m8w.test.ts`（新增） | 回归测试（提问 + 审批两种情形） |
| `README.md` | 术语说明补一句「等待你处理期间不接新回合」 |

## 四、关键实现

```ts
// runtime-state.ts（纯函数，HTTP 与 WS 共用）
deriveAgentState({ enabled, occupancy, hasPendingApproval, hasPendingQuestion })
// disabled > meeting > waiting > working > idle（waiting 压过 working → 等待期间不算"工作中"）
```

```ts
// loop-runner.ts runDirectTurn
const runtime = await toolRuntime.runtimeState?.(ctx)   // 单点推导
const onStandby = runtime === 'waiting'
if (occupancy && !onStandby) { await acquire(working); emit working }
else if (occupancy) emit waiting
try { if (!onStandby) return await runTurnCore(ctx) }   // 等待期间不开工
finally {
  release(本会话)
  if (onStandby) { await flushDeferred(); return }
  ...会议恢复...
  const state = await toolRuntime.runtimeState?.(ctx)    // 单点推导
  emit agent.state = state
  await flushDeferred()
}
```

## 五、验证

- 新增 `tests/agent-state-waiting-m8w.test.ts`（修复前红、修复后绿）。
- 相关回归：`team-status-m8i`、`ask-user-suspend-m8t`、`approval-blocking-m8v`、
  `question-ws-push-m8l`、`question-list-m8u`、`tool-loop-m8g`、`meeting-*`（会议不回归）。
- 全量：`npm run test`、`npm run typecheck`、`npm run lint`。

## 六、不做的事

- 不引入新的状态枚举（仍是 idle/working/meeting/waiting/disabled）。
- 不改 `ask_user` 队列、去重、卡片交互等既有语义。
- 不为「等待期间被丢弃的唤醒」新建补跑机制：消息仍落盘，用户答复/后续消息会带着它进入下一回合。
