# 修改记录 · S49 去掉「停止生成」；暂停在轮次边界停止循环

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s49-pause-at-loop-boundary.md](../plan/2026-09-19-s49-pause-at-loop-boundary.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §2/§3、[orchestration.md](../design/orchestration.md) §5、[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-33 / D52

## 1. 需求 / 问题

用户口径：**"不要停止生成按钮，暂停会给每个 agent 设置状态，进入暂停状态，每个 agent 执行完一轮 loop 后，判断是否是暂停，如果是就停止循环，生成已经停止。"**

现状（S37 之后）与口径的差距：

| 现状 | 差距 |
| --- | --- |
| 会话头与运行细条各有一个「停止生成」按钮（`stop{scope:'turn'}`：abort 在途回合、本条作废不重放） | 用户不要这个按钮 |
| 「暂停」= 置 `paused` + **立刻 abort** 在途回合（连正在流的模型调用一起切断） | 用户要的是"**跑完当前这一轮 loop** 再停"，不砍断当前这轮 |
| 循环的中断点本来就在"每轮开始处"（`runToolLoop` 每轮前、`plan-execute` 每步前），但只认 `signal.aborted` | 暂停要在这个边界生效，需要一种"非 abort"的可见性 |

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/turn.ts` | `TurnRunContext` 增可选 `isPaused?: () => boolean`（注释：每轮 loop 开始时检查；暂停**不切断**在途模型调用） |
| application | `src/application/agent-loop/runner.ts` | `shouldInterrupt = isPaused() \|\| signal.aborted` —— 暂停与硬中断在同一个"每轮检查点"生效 |
| application | `src/application/dispatcher/dispatcher.ts` | `setPaused` **不再 abort**（只登记 `pauseIntent` + 落盘）；`drainLocked` 把 `isPaused` 传给回合；回合收尾按"暂停标记/意图"→ **游标不推进 + 跳出队列循环**，并落 `state{paused:true, note}`；`activeTurns.reason` 收窄为 `'stop'`（暂停不再走硬中断路径） |
| web | `web/src/pages/SessionPanel.tsx` | **删除「停止生成」Popconfirm**；暂停确认文案改为"不再领新任务；当前这一轮 loop 跑完就停止生成，之后点「恢复」继续" |
| web | `web/src/pages/WorkingBar.tsx` | **删除「停止生成」按钮**与 `stop('turn')` 调用（只留「停止任务」）；文件头注释同步 |
| web | `web/src/lib/stop-feedback.ts` | 删除 `stopTurnFeedback`（已无消费方），只留 `stopTaskFeedback` |
| tests | `tests/integration/server/pause-interrupt.test.ts`（重写）、`tests/unit/web/stop-feedback.test.ts`（收敛） | 见 §4 |
| docs | `prd`（**D52** + FR-33 补注）、`agent-runtime.md` §2/§3、`orchestration.md` §5、`contract.md`、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s49` | 全链路回写 |

**未改**：loop 结构与轮数上限（`MAX_TOOL_ROUNDS`）；`stop{scope:'task'}`（停止任务）；`POST /agents/:iid/stop {scope:'turn'}` 接口本身（**保留、界面无入口**，供脚本/兜底）；`paused` 作为"每 Agent 一个调度开关"的性质；S38 的状态文案。

## 3. 关键决定

1. **暂停≈给 loop 一个"下一轮别再开始"的信号**：新增 `isPaused()` 而不是复用 `signal.aborted`——因为 abort 会**切断在途模型调用**，而用户要"这一轮跑完"。
2. **游标口径不变**：暂停导致回合收尾时**不推进游标**（被中断那条留在队列，`resume` 补处理）——判定依据从"abort 原因"改为"暂停标记/意图"；日志改记 `state{paused:true}`。
3. **按钮去掉、接口保留**：`stop{turn}` 在契约里仍有（脚本/兜底可用），但界面不再暴露；`stopTurnFeedback` 随之删除避免死代码。
4. **细条只留「停止任务」**：任务级终止（含未结算改动先结算快照）与"暂停"解决的是两件事，不能混。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| **集成（核心）** | `pause-interrupt.test.ts` **2 passed**：网关卡住**第一次**模型调用并要求调工具（正常会进入下一轮）——期间暂停后断言：① `abortedDuringCall=false`（**在途调用未被切断**）② 暂停后模型调用总数 **1**（停在下一轮之前）③ 会话日志有 `state{paused:true}` ④ `{state:'idle',paused:true,queued:2}`（被中断那条 + 排队那条都在）⑤ `resume` 后补处理 2 条、`turn_start` 共 3、调用数 **1 + 2×5**（不暂停时每轮都继续要工具 ⇒ 每条消息跑满 5 次调用，反证"暂停确实停住了循环"） |
| 单元 | `stop-feedback.test.ts` 收敛为 2 条（停止任务文案） |
| 前端检索 | `web/src` 内不再有「停止生成」按钮（仅剩注释与暂停文案） |
| typecheck / eslint | 0 错误（src + web） |
| 全量测试 | `npm test` **63 files / 390 tests 全绿** |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-D5G05hX2.js`（1,377.19 kB / gzip 431.16 kB） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— ① 点「暂停」时当前这一轮跑完才停（不是当场砍断）② 「恢复」后队列继续 ③ 界面上找不到「停止生成」 |
| 说明 | 与 S15~S48 的交付口径一致 |

## 5. 遗留

- **本轮已开始的工具仍会执行**：检查点在"每轮 loop 开始处"，所以暂停后当前轮的模型调用与其后续工具调用会跑完。若要"下一步工具也别跑"，需把检查点前移到每次工具调用前——那是更细的中断粒度（用户未要求）。
- **暂停响应延迟**：等于"当前这一轮剩余时间"（一次模型调用 + 该轮工具）。想更快只能回到"切断在途调用"（S37 口径，本轮被用户否掉）。
- **`stop{scope:'turn'}` 无界面入口**：接口与用例保留，文档标注"供脚本/兜底"；若长期无人用可考虑删除（需同时改契约与用例）。
- **`state{paused:true}` 是新的事件形状**：`traceLine` 会按 `state` 分支展示 JSON（S35 的兜底），未专门美化。
