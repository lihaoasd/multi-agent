# S49 方案：去掉「停止生成」按钮；暂停 = 跑完当前这一轮 loop 后停止循环

> 日期：2026-09-19　类型：用户口径（"不要停止生成按钮，暂停会给每个 agent 设置状态，进入暂停状态，每个 agent 执行完一轮 loop 后，判断是否是暂停，如果是就停止循环，生成已经停止"）　真源：`design/agent-runtime.md` §2/§3、`design/orchestration.md` §5、`prd.md` FR-33
> 关联：`docs/changes/2026-09-19-s49-pause-at-loop-boundary.md`、`docs/plan/development.md`

## 1 需求

用户口径拆成四条：

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **不要「停止生成」按钮** | 会话头与运行细条上都不再有该按钮（接口保留，但界面无入口） |
| R2 | **暂停给每个 Agent 设置状态** | 暂停是按实例的状态（`paused`），界面显示「已暂停」，且不再领新活 |
| R3 | **每跑完一轮 loop 判断是否暂停，是则停止循环** | 在途的模型调用**不被切断**；当前这一轮跑完后循环跳出，生成停止 |
| R4 | 停下来的那一条不丢 | 被中断的消息**留在队列**（游标不推进），「恢复」后补处理；会话日志留下"暂停"事实 |

## 2 现状（S37 之后）与差距

| 现状 | 与用户口径的差距 |
| --- | --- |
| `停止生成`（`stop{scope:'turn'}`）= abort 在途回合、**本条消息作废不重放**，界面在会话头与细条各有一个按钮 | R1：要去掉按钮 |
| `暂停` = 置 `paused` + **立刻 abort 在途回合**（连正在流的模型调用也一起切断） | R3：用户要的是"**跑完当前这一轮**再停"，而不是把当前这轮砍断 |
| 循环中断点已在"每轮开始处"检查（`shouldInterrupt()`：`plan-execute` 每步前、`runToolLoop` 每轮前） | 但中断信号只有 `signal.aborted`（abort）——暂停若想"轮次边界"生效，就必须换一种可见性 |

## 3 关键决定

1. **暂停不再 abort，改为"意图可见"**：`setPaused(true)` 只登记 `pauseIntent`（内存即时可见）+ 落盘 `paused`；
   通过新增的 `TurnRunContext.isPaused()` 把暂停状态传给 loop，`runner` 把
   `shouldInterrupt` 改成 `isPaused() || signal.aborted`。于是**每一轮 loop 开始时**检查 →
   **当前这一轮照常跑完（含它的模型调用与工具），下一轮不再开始**，正是用户说的"执行完一轮 loop 后判断"。
   （`signal.aborted` 仍保留给"停止生成/停止任务"这类硬中断。）
2. **游标口径不变**：暂停导致回合收尾时**不推进游标**（消息留在队列、恢复后补处理）——与 S37/规则 26 一致；
   只是判定依据从"abort 原因"换成"暂停标记/意图"。会话日志改记 `state{paused:true}`（供 Agent 按 S21/D27 自查）。
3. **去掉界面入口，保留接口**：`POST /agents/:iid/stop {scope:'turn'}` 仍在（契约与测试保留，供脚本/兜底），
   但**会话头与运行细条都不再提供按钮**；`stopTurnFeedback` 随之删除（无消费方）；细条只留「停止任务」。
4. **暂停的可见状态**：`paused` 仍是**每 Agent 一个**的调度开关（不是状态机状态），左栏/节点显示「已暂停」（S19/S38 口径不变）。
5. **不改 loop 结构**：不加新的中断点、不改 `MAX_TOOL_ROUNDS`；只把"暂停"接进既有的每轮检查。

## 4 实现步骤

- `src/ports/turn.ts`：`TurnRunContext` 增可选 `isPaused?: () => boolean`（注释写明"每轮 loop 结束时检查，不切在途调用"）。
- `src/application/agent-loop/runner.ts`：`shouldInterrupt: () => context.isPaused?.() === true || context.signal.aborted`。
- `src/application/dispatcher/dispatcher.ts`：`setPaused` **不再 abort**（只登记意图/落盘）；`drainLocked` 把
  `isPaused` 传给回合；回合收尾按"暂停标记或意图"决定**游标不推进 + 跳出队列循环**，并落 `state{paused:true}`；
  `activeTurns` 的 `reason` 收窄为 `'stop'`（暂停不再走硬中断）。
- `web/src/pages/SessionPanel.tsx`：删除「停止生成」Popconfirm；暂停确认文案改成"当前这一轮 loop 跑完就停止生成"。
- `web/src/pages/WorkingBar.tsx`：删除「停止生成」按钮与 `stop('turn')` 调用（只留「停止任务」）。
- `web/src/lib/stop-feedback.ts`：删除 `stopTurnFeedback`（无消费方）；测试同步收敛。
- 测试：重写 `tests/integration/server/pause-interrupt.test.ts` 为"轮次边界暂停"（见 §5）。
- 文档回写：`prd` **D52** + FR-33 补注、`agent-runtime.md` §2/§3、`orchestration.md` §5、`contract.md`、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s49`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 集成（核心） | `pause-interrupt.test.ts`：网关把**第一次**模型调用卡住并让它"要求调工具"（正常会进入下一轮）；期间暂停 → 断言 ① 在途调用**未被切断**（`abortedDuringCall=false`）② 暂停后模型调用总数 **1**（停在下一轮之前）③ `state{paused:true}` 落进会话 ④ `queued=2`（被中断那条 + 排队那条都还在）⑤ `resume` 后补处理 2 条、`turn_start` 共 3、调用数 `1 + 2×5`（说明不暂停时循环照常跑满 5 轮） |
| 单元 | `stop-feedback.test.ts` 收敛为停止任务文案（2 条） |
| 回归 | `npm test` 全绿 + `coverage` 143/143 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| 前端检索 | 全仓 `web/src` 不再有「停止生成」按钮（只剩注释/文案） |
| **用户点验** | ① Agent 跑长任务时点「暂停」→ 它把当前这一轮跑完就停（不是当场砍断），状态变「已暂停」② 点「恢复」→ 队列（含被打断那条）继续 ③ 界面上找不到「停止生成」按钮 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 暂停"等一整轮"看起来慢（尤其一轮里模型很慢） | 这是用户明确要的口径（轮次边界）；一轮的边界由 `shouldInterrupt()` 决定，最长＝一次模型调用 + 该轮工具调用 |
| 暂停后工具仍会执行（本轮已开始） | 与"跑完这一轮"一致；若希望"下一步工具不再执行"，需要把检查点前移到每次工具调用前（属新口径） |
| 用户找不到"立刻停"的入口 | 明确：要立刻停就「暂停」（下一轮不再开始）；要终止整个任务用「停止任务」 |
| `stop{scope:'turn'}` 无界面入口后被误当死代码删除 | 契约与用例保留（脚本/兜底），文档写明"界面无入口" |
