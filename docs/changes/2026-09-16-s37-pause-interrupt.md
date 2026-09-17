# 修改记录 · S37 暂停/停止的回合中断语义修复

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s37-pause-interrupt.md](../plan/2026-09-16-s37-pause-interrupt.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §2/§3、[orchestration.md](../design/orchestration.md) §5、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-33 / D40

## 1. 需求 / 问题

用户口径：**"停止生成是什么功能，暂停无效"**。

- 「停止生成」＝会话头 / 运行细条上的 `POST /agents/:iid/stop {scope:'turn'}`：停**当前回合的输出**（队列保留、任务不动）；与之并列的「停止任务」（`scope:'task'`）才会终止任务并结算快照。
- 「暂停」按了没用 —— 是真缺陷，根因有三处（详见方案 §2）：**① 暂停请求与 drain 抢同一把锁、只能等整个队列跑完；② drain 循环只在入口查一次 `paused`，被中断后继续取下一条；③ 被中断的回合照样推进游标**（与 S4/S8 方案、规则 26、`ports/dispatcher.ts` 写的"游标不推进、消息留在队列、恢复补处理"不符）。历史用例只覆盖"空闲时暂停"，这条路径此前无用例。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| application | `src/application/dispatcher/dispatcher.ts` | `activeTurns` 值改为 `{controller, reason: 'pause' \| 'stop' \| null}`；新增内存 `pauseIntent` 与 `abortActiveTurn(instanceId, reason)`；`drainLocked` **入口与循环顶**各查一次暂停意图、回合被中断后 `break`；按 `reason` 决定是否推进游标（`pause` 不推进）；中断后 `emit state{turnAborted:true, reason, note}`；`setPaused` 把"登记意图 + abort"提到**取锁之前**（锁内只落盘）；`statusOf().paused` 叠加内存意图 |
| ports | `src/ports/dispatcher.ts` | `setPaused`/`abortTurn` 的契约注释改写为真实口径（暂停＝挂起并立即中断、游标不推进；停止生成＝本条作废不重放、剩余队列不自动续跑） |
| web | `web/src/lib/stop-feedback.ts`（新）、`web/src/pages/{SessionPanel,WorkingBar}.tsx` | 停止结果文案抽成纯函数并**如实反馈**：`aborted=false` 时说"当前没有正在生成的回合（该 Agent 空闲或已暂停）"；`queued>0` 时说明"队列保留 N 条，下次触发时处理"；停止任务文案同源收口 |
| tests | `tests/integration/server/pause-interrupt.test.ts`（新 2 条）、`tests/unit/web/stop-feedback.test.ts`（新 4 条） | 见 §4 |
| docs | `prd`（**D40** + FR-33 补注）、`agent-runtime.md` §2/§3、`orchestration.md` §5、`contract.md`、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s37` | 全链路回写 |

**未改**：`pause`/`resume`/`stop` 的接口与返回字段；前端按钮与布局；S21/D27 的"平台不判定未完成回合"；跨重启的排队消息恢复（D18-③）。

## 3. 关键决定

1. **暂停意图先于锁**：`drain` 持锁跑完整个队列是"至少一次"语义的需要，不能为了暂停去拆锁；正确做法是让中断**不排队等锁**（意图 + abort 都在锁外），落盘再等锁。
2. **中断按原因分口径**：`pause`＝挂起（游标不推进 → 恢复补处理，FR-33 的承诺）；`stop`＝停止生成（本条作废、不重放，避免"用户已喊停还要重跑一遍"）。两者都**不再续跑剩余队列**——按下停止后立刻接着跑下一条，正是用户觉得"停不下来"的原因。
3. **中断事实落日志**：S21/D27 明确"平台不判定未完成回合、Agent 靠会话日志自查"；被中断的回合如果不留痕，在日志里与正常回合无异。因此收尾时写一条 `state{turnAborted, reason, note}`（trace 视图可见，`session_recent` 可读）。
4. **诚实反馈**：`aborted=false` 时不再假报成功——这直接回答用户"停止生成是什么功能"。
5. **不改接口、不加控件**：三个入口不变，避免为一个语义修复扩散到契约。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（`tsc -p tsconfig.json` + `tsc -p web/tsconfig.json`；`npx eslint .`） |
| **先复现后修复** | `pause-interrupt.test.ts` 先写用例：**修复前跑红**（④ 中断信号未在模型调用途中到达；⑥ 队列被续跑）；修复后 **2 passed** |
| **反向验证** | 临时退掉修复（去掉锁外 abort → 红在 ④；去掉两处 `break` + 游标保持 → 红在 ⑥ "expected 2 to be 1"，即第 2 条消息被送进模型），证明断言确实压在缺陷上，而不是"顺手绿" |
| 新用例内容 | ① 回合中途暂停：模型调用途中就收到中断信号 → 中断事实入日志 → **只有 1 个回合** → `queued=2`（被打断的 + 排队的都留着）→ `resume` 补处理 **2 条**、`turn_start` 共 3 次；② 空闲时 `stop` 如实回 `aborted=false` |
| 前端单测 | `tests/unit/web/` **20 passed**（stop-feedback **4**（真停到 / 没停到 / 停止任务两种）+ event-display 10 + question-wizard 6） |
| 全量测试 | `npm test` **55 files / 349 tests 全绿**（S36 基线 53 / 343） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0**（基线 0） |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BUqduAvF.js`（1,373.26 kB / gzip 429.84 kB，+0.11 kB gzip——只多了文案纯函数） |
| **未覆盖** | 无浏览器自动化：**须用户点验** ① 长回合中点「暂停」输出立刻停、状态变「已暂停」② 暂停期间发消息仍提示排队 ③ 点「恢复」补处理队列 ④ 空闲时点「停止生成」看到"当前没有正在生成的回合" |
| 说明 | 与 S4/S7/S8/S12/S15~S36 的交付口径一致 |

## 5. 遗留

- **暂停后恢复会重放被打断的那条消息**（可能重复工具调用/计费）：这是"游标不推进、不丢用户消息"契约的代价（S4/S8 既定口径），本轮只是把实现补齐；若将来要"续跑半截回合"，需要按 `plan` 断点续做（不是重放）——属新功能。
- **停止生成后剩余队列不再自动续跑**：发送下一条消息即触发补处理；`POST /api/projects/:pid/dispatcher/resume-queued` 是同语义的接口兜底，但**界面仍未暴露**该按钮（S8 遗留，仍然存在）。
- **跨进程/多实例部署**：`abortTurn` 只对本进程的活动回合生效（S8 记录在案），多进程下暂停/停止需要共享状态。
- **`stop(scope='task')` 不向受派人回注"任务已被用户终止"**：设计文档（agent-runtime §6）有此承诺，实现只通知了委派人；本轮未动（`reason='stop'` 时游标照常推进，所以也不会在已终止任务上重放）。
- **`pauseIntent` 是进程内状态**：进程重启后为空，由 `runtime.state.json` 的 `paused` 标记兜底（暂停期间重启仍然是暂停）。
- **前端仍无 DOM/组件测试**（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36 记录）。
