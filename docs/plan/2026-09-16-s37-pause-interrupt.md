# S37 方案：暂停/停止的回合中断语义修复（用户报告"暂停无效"）

> 日期：2026-09-16　类型：用户报告（"停止生成是什么功能，暂停无效"）　真源：`design/agent-runtime.md` §2/§3、`design/orchestration.md` §5、`api/contract.md`、`prd.md` FR-33
> 关联：`docs/changes/2026-09-16-s37-pause-interrupt.md`、`docs/plan/development.md`

## 1 需求

用户口径：**「停止生成」到底是什么功能；「暂停」按了没用。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 暂停**当场**生效 | 在途回合立刻在可中断点收尾（模型流被 abort），不是"等它把活干完" |
| R2 | 暂停后**不再续跑队列** | 队列里剩下的消息不被自动处理 |
| R3 | 暂停＝挂起，恢复＝补处理 | 被中断的消息**留在队列**，`resume` 后重新处理（FR-33 / 规则 26 / S4·S8 契约） |
| R4 | 停止生成＝停当前输出、不吃掉队列 | 本条消息作废（不重放，避免重复烧 token），剩余队列**不自动续跑**，留待用户下次触发 |
| R5 | 中断事实进会话日志 | 落一条 `state{turnAborted,reason}`，供 Agent 按 S21/D27 自查 |
| R6 | 不改接口、不加按钮 | `pause`/`resume`/`stop` 契约不变（诚实反馈只改文案） |

## 2 根因（三个，叠在一起才表现为"暂停无效"）

| # | 位置 | 问题 |
| --- | --- | --- |
| ① | `dispatcher.setPaused` | 与 `drain` **抢同一把 keyed lock**，而 `drainLocked` 持锁跑完**整个队列（含所有回合）**。于是"忙的时候点暂停"要等 Agent 把队列干完才落盘——那时已经没有什么可暂停的了。`activeTurns.abort()` 写在锁内，同样迟到 |
| ② | `dispatcher.drainLocked` 的 `for(;;)` | `paused` **只在入口查一次**；回合被中断后循环继续取下一条队列消息 → 用户看到"按了暂停它还在干" |
| ③ | 回合收尾 | 被中断的回合**照样推进游标** → 与 `ports/dispatcher.ts`、S4/S8 方案、规则 26 写的"暂停：游标不推进、消息留在队列、恢复补处理"不符；中断后既没重放也没提示，消息等于被吞掉 |

契约与实现的偏差之所以长期没被发现：既有用例只覆盖**空闲时暂停**（`sessions-api.test.ts`：pause → 发消息 → `queued=1`），"暂停落在回合中途"这条路径从来没有用例。

## 3 关键决定

1. **暂停意图先于锁**：`setPaused(true)` 在**取锁之前**登记内存暂停意图 + `abort` 在途回合（两条都不需要锁），再走锁落盘。中断信号因此**立即**送达，落盘可以等锁释放。
2. **中断要区分原因**（`activeTurns` 的句柄带 `reason`）：
   - `pause`＝**挂起**：游标不推进（消息留在队列），`resume` 后补处理 → FR-33 的"挂起/恢复"；
   - `stop`＝**停止生成**：本条作废（游标照常推进，不重放），避免"用户已经喊停还要重跑一遍"。
3. **中断后不再续跑队列**：暂停等恢复；停止生成把剩余消息留给用户下次触发（发送新消息 / `resume-queued`）。
4. **中断事实落日志**：回合收尾后写 `state{turnAborted:true, reason, note}`——S21/D27 明确"平台不判定未完成回合、Agent 靠会话日志自查"，没有这条事实，被中断的回合在日志里与正常回合无异。
5. **诚实反馈**：`stop` 的 `aborted=false`（当时没有在途回合）时，界面说"当前没有正在生成的回合"，不再假报成功；文案抽成纯函数 `web/src/lib/stop-feedback.ts`（可单测）。
6. **不改接口、不加控件**：暂停/恢复/停止生成三个入口沿用（`POST .../agents/:iid/{pause,resume,stop}`），本轮只改行为与文案。

## 4 实现步骤

- `src/application/dispatcher/dispatcher.ts`：`activeTurns` 值改为 `{controller, reason}`；新增 `pauseIntent` 与 `abortActiveTurn(instanceId, reason)`；`drainLocked` 入口与循环顶各查一次暂停意图、回合被中断后 `break`；按 `reason` 决定是否推进游标；中断时 `emit state{turnAborted}`；`setPaused` 把意图登记 + abort 提到锁外；`statusOf` 的 `paused` 叠加内存意图（意图已生效但标记未落盘的窗口里，投影也要说"已暂停"）。
- `src/ports/dispatcher.ts`：`setPaused`/`abortTurn` 契约注释改写为上述口径。
- `web/src/lib/stop-feedback.ts`（新）+ `SessionPanel`/`WorkingBar` 改用 `stopTurnFeedback`/`stopTaskFeedback`。
- 测试：`tests/integration/server/pause-interrupt.test.ts`（2：回合中途暂停的完整闭环 + 无在途回合时 `aborted=false`）、`tests/unit/web/stop-feedback.test.ts`（4）。
- 文档回写：`prd` **D40** + FR-33 补注、`agent-runtime.md` §2/§3、`orchestration.md` §5、`contract.md`、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s37`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| **先复现** | `pause-interrupt.test.ts` 先写用例、**在未修复代码上跑红**（④ 中断未送达 / ⑥ 队列被续跑），修复后转绿 |
| 反向验证 | 临时退掉修复（去掉锁外 abort、去掉两处 `break` 与游标保持）→ 用例分别红在 ④ 与 ⑥，证明断言确实压在缺陷上 |
| 集成 | `pause-interrupt`（含"暂停中途→只剩 1 个回合→`queued=2`→`resume` 补处理 2 条"）、`sessions-api`、`runtime-api` 回归 |
| 单测 | `tests/unit/web/stop-feedback.test.ts` 4 条（真停到 / 没停到 / 停止任务两种） |
| 全量 | `npm test`、`npm run coverage`、`npm run ratchet`、`typecheck`、`eslint`、`npm run build` |
| **用户点验** | ① 让 Agent 跑一个长回合，点「暂停」→ **输出应立刻停**、状态变「已暂停」；② 再发消息仍提示排队；③ 点「恢复」→ 队列（含被打断那条）被补处理；④ Agent 空闲时点「停止生成」→ 提示"当前没有正在生成的回合"而不是成功 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 暂停后恢复会**重放**被打断的那条消息（可能重复工具调用/计费） | 这是 S4/S8 契约（游标不推进）的必然代价，也是"不丢用户消息"的选择；文档写明，且日志里有 `turnAborted` 事实可查 |
| 停止生成后剩余队列不再自动续跑，用户以为消息丢了 | 界面与日志明示"队列保留 N 条"；发送下一条消息即触发补处理（`resume-queued` 仍是兜底入口） |
| 内存暂停意图与落盘标记不一致 | 意图只做"提前收敛"，持久真相仍是 `runtime.state.json`；`resume` 先清意图再落盘；重启后意图为空、由落盘标记兜底 |
| 中断落在"上一回合刚完、下一回合没起"的缝里 | 循环顶查内存意图（该窗口锁外的 abort 找不到活动回合，只能靠意图拦住） |
| 多进程部署下中断只对本进程有效 | 已知边界（S8 记录在案），本轮不变 |
