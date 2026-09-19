# S47 方案：修「系统挂了」——嵌套唤醒死锁 + 重启后不恢复

> 日期：2026-09-19　类型：用户报告（"系统挂了，原有是审批和询问都失效"）　真源：`design/agent-runtime.md` §2/§7、`design/sandbox.md` §5、`prd.md` FR-14 / FR-29
> 关联：`docs/changes/2026-09-19-s47-wake-deadlock-recovery.md`、`docs/plan/development.md`

## 1 需求

用户口径：**系统挂了；审批和询问都失效。**

先说现场诊断（本机真实项目 `p_mu7rs071omcf1` 的运行态快照）：

| 观察 | 值 | 含义 |
| --- | --- | --- |
| `pm_1` | `state=working`，`occupancy since 06:51:43`，最后事件是 **06:53:02 的 `tool_call task_assign`（没有结果）** | pm_1 的回合**卡在 task_assign 工具里** |
| `dev_1` | `state=waiting`，`waitingFor=approval`，最后事件 **06:54:39 `command`（待审批）** | dev_1 的回合在**等用户批准一条内联命令** |
| `dev_1` 的 `lastHandledSeq` | **不存在**（游标 0） | dev_1 一个回合都没收尾 |
| 各 Agent 队列 | pm_1 5 条、dev_1 3 条、architect_1 3 条 | 有 11 条排队消息推不动 |

把两条线索合起来就是根因：**`pm_1` 的 `task_assign` 触发的"唤醒"是嵌套执行的**——
`task_assign` → 平台通知受派人 → `wake` 里 `await dispatcher.drain(dev_1)` → **dev_1 的整个回合跑在 pm_1 的回合内部**
（`drain` 持 `agent:pm_1` 锁不释放）；而 dev_1 的回合又卡在等审批。于是 pm_1 表现为"永远工作中"，
用户看到的就是"系统挂了"。

## 2 根因（三处，环环相扣）

| # | 位置 | 问题 |
| --- | --- | --- |
| ① **嵌套唤醒 → 互等死锁** | `src/bootstrap/composition-root.ts` 的 `notifier.wake` | `wake` 是"注入一条系统消息 + **await `drain`**"，而它的调用方（`task_assign`/`task_update`/答复询问…）**都发生在某个回合的工具调用里**。`drain` 会持 `agent:<自己>` 锁跑完整个回合 → 出现 **A 的 drain 等 B 的回合、B 的回合又唤醒 A** 的环形等待；keyed lock 不可重入、也没有超时 → **永久卡死**（不是"慢"，是永远不动） |
| ② **重启后不补处理排队消息** | `src/bootstrap/main.ts` 启动自检 | 只做 `resetStaleOccupancy`（清残留占用），**没有** `resumeQueued`——D18-③ 早就承诺"重启后对队列非空且无占用的 Agent 补一轮处理"，实现里一直没有。后果：进程一重启（`tsx watch` 每次保存都重启！），排队消息全躺下，用户看到"发消息没反应" |
| ③ **审批决定没有等待者时不通知申请者** | `src/application/approval/approval-service.ts` 的 `decide` | 等待者是**进程内**的（跨重启口径：pending 保持、等待者消失、回合不在）。重启后用户点"批准/拒绝"只落盘、**没有人被唤醒** → "审批点了没用"。对比：询问答复（`question-service.answer`）一直会 `notify` 唤醒提问者，所以"询问"本来不该有此问题——但被 ① 的锁卡住时同样表现为失效 |

## 3 修复

1. **唤醒不再 await**（`composition-root.wake`）：把"消息落盘"与"排一次 drain"分开——append 成功后
   `void dispatcher.drain(...).catch(warn)`，**只排不 await**。于是：
   - `task_assign` 立刻拿到结果，pm_1 的回合正常收尾、锁释放；
   - 受派人仍会被唤醒（drain 只是异步化），但不再**嵌套**在别人的回合里 → 环形等待消失；
   - 顺带解决"pm_1 看起来一直在工作中"的观感（它不再替受派人等整个回合）。
2. **启动自检补处理排队消息**（新增 `src/bootstrap/startup.ts` 的 `recoverOnStartup`，`main.ts` 调用）：
   逐项目 `resetStaleOccupancy` → `resumeQueued`；单个项目失败不影响其它项目；抽成可测函数（`main()` 里只调一次）。
   这就是 D18-③ 的兑现：**重启后系统自己动起来**。两处细节（上线当时就踩到了）：
   - **必须放在 `listen` 之后且不阻塞**：补处理会真的跑 Agent 回合（几十秒到几分钟）。放在 `listen` 之前会把 HTTP 服务一起挡住——本机实测就是"前端 vite 代理一直 `ECONNREFUSED 127.0.0.1:3000`"。现在 `main.ts` 先 `listen`（日志"服务已启动"），再 `void recoverOnStartup(...)`（失败仅告警）。
   - **`resumeQueued` 改为"逐 Agent 只排不 await"**：补处理是逐个 Agent 的，而某个 Agent 的回合可能**卡在"等用户答复"**上；原先逐个 `await drain` 会让第一个卡住的 Agent 挡住后面全部（本机实测：`architect_1` 一提问，`pm_1`/`dev_1` 的队列永远轮不到）。`drain` 自身按 Agent 串行（keyed lock），并发排入是安全的；`resumeQueued` 返回的 `resumed` 语义相应变为"**已排**（不保证已完成）"。
3. **审批决定在无等待者时唤醒申请者**（`approval-service`）：`decide` 时若 `waiters` 里没有该审批
   （典型是进程重启过），落盘后 `notify` 申请者一条 `[审批] 你的申请已被批准/拒绝：<summary>。请据此继续…`，
   与询问答复的处理方式对齐。

**不改**：`POST /messages` 的等待语义（S46 已按会话隔离 UI 状态）；`POST /install`？——不涉及；keyed lock 实现（不引入重入，改为**不在回合内嵌套 drain**）；S21/D27"平台不判定未完成回合"。

## 4 验证方式

| 层 | 手段 |
| --- | --- |
| **先复现**（死锁） | 新增 `tests/integration/server/nested-wake-deadlock.test.ts`：pm 派单 → dev 领取并汇报 → **委派人被唤醒并继续**；修复前该用例在"委派人收到回报并继续"处**超时 12s**（死锁），修复后 **350ms 通过** |
| 反向验证 | 临时把 `wake` 改回 `await dispatcher.drain(...)` → 用例再次超时（已实测），证明断言压在缺陷上 |
| 重启恢复 | 新增 `tests/integration/server/restart-recovery.test.ts`（**4 条**）：① 造"有队列无占用"的重启态（暂停→发消息→只改暂停标记）后调 `recoverOnStartup`，断言 `resumed` 含该 Agent 且消息被真的处理（`turn_end`、队列归零）；② 无等待者的审批被批准 → 申请者收到 `[审批] 你的申请已被批准` 唤醒；③ 接线用替身钉住"逐项目清占用 + 补处理，单个项目失败不影响其它"；④ **补处理时一个 Agent 卡在"等答复"不能挡住其它 Agent**——断言 `resumeQueued` 5s 内返回且 `qa_1` 的回合真的跑完（`architect_1` 同时进入 `waiting/question`）；**反向验证**：把 `resumeQueued` 退回"逐个 await"，该用例 20s 超时（已实测） |
| 启动自证 | 用临时数据目录在备用端口（3101）启动一次 → `/health` **200**（证明改动不会导致起不来） |
| 回归 | `npm test` 全绿 + `coverage`（143/143）+ `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | 重启开发服务后：① 各 Agent 队列自动被处理（不再"躺尸"）② 待审批项点批准/拒绝时，申请者会被唤醒（`[审批] …` 消息）③ 一个角色派单不再让另一个角色"卡住不动" |

## 5 风险

| 风险 | 对策 |
| --- | --- |
| 唤醒异步化后"受派人没被叫醒" | 消息仍**先落盘**（游标未推进就一定会被处理），drain 只是排一次；失败记 `warn` |
| 启动自动补处理会消耗 token | 处理的是**用户已经发出的**排队消息（本来就该跑）；暂停中的 Agent 不动（`resumeQueued` 跳过 paused）；日志明确打印 `resumed` 列表 |
| 一个项目数据损坏拖垮启动 | `recoverOnStartup` 逐项目 try（Result 判错）+ 失败仅告警、继续下一个 |
| 审批唤醒变成"重复打扰" | 只在**没有等待者**时通知（有等待者时回合自己会继续）；文案里写明"若该动作已不再需要，忽略本条即可" |
| 仍有别处可能嵌套 drain | 在 `wake` 与 `drain` 注释里写明硬约束：**不要在某个回合内 await 另一个 Agent 的 drain**（当前只有 wake 会在回合内被调用） |
