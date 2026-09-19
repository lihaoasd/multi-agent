# 修改记录 · S47 修「系统挂了」：嵌套唤醒死锁 + 重启后不恢复

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s47-wake-deadlock-recovery.md](../plan/2026-09-19-s47-wake-deadlock-recovery.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §2/§7、[sandbox.md](../design/sandbox.md) §5、[prd](../requirements/prd.md) FR-14 / FR-29 / D50

## 1. 需求 / 问题

用户报告：**"系统挂了，原有是审批和询问都失效。"**

### 现场诊断（本机真实项目 `p_mu7rs071omcf1` 的快照）

| 观察 | 值 |
| --- | --- |
| `pm_1` | `working`、占用自 06:51:43、最后事件 **06:53:02 的 `tool_call task_assign`（无结果）** |
| `dev_1` | `waiting`、`waitingFor=approval`、最后事件 **06:54:39 的 `command`（待审批）** |
| `dev_1` 游标 | `lastHandledSeq` **不存在**（一回合都没收尾） |
| 队列 | pm_1 5 条、dev_1 3 条、architect_1 3 条（共 11 条推不动） |

**根因**：`task_assign` 的"唤醒"是**嵌套**执行的——`task_assign` → 通知受派人 → `wake` 里 `await dispatcher.drain(dev_1)` → **dev_1 的整个回合跑在 pm_1 的回合内部**（`drain` 持 `agent:pm_1` 锁不释放），而 dev_1 又卡在等审批。pm_1 于是"永远工作中"。

## 2. 三个缺口

| # | 位置 | 问题 |
| --- | --- | --- |
| ① | `src/bootstrap/composition-root.ts` `notifier.wake` | **嵌套唤醒 → 环形等待**：`wake` = append + `await drain`，而它的调用方都在某个回合的工具调用里；`drain` 持自己的锁跑完整个回合 → "A 的 drain 等 B 的回合、B 的回合又唤醒 A"→ **永久死锁**（keyed lock 不可重入、无超时） |
| ② | `src/bootstrap/main.ts` 启动自检 | 只 `resetStaleOccupancy`、**没有** `resumeQueued`——D18-③ 承诺的"重启后补一轮排队消息"从未实现。`tsx watch` 每次保存都重启，于是排队消息全躺下（"发消息没反应"） |
| ③ | `src/application/approval/approval-service.ts` `decide` | 等待者是**进程内**的；重启后用户点"批准/拒绝"只落盘、**没人被唤醒** → "审批点了没用"（询问答复一直有 `notify`，所以对齐即可） |

## 3. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| bootstrap | `src/bootstrap/composition-root.ts` | `wake` 改为"消息落盘 + **只排不 await** drain"（`void … .catch(warn)`）；把 `notifier`/`wake` 的间接层上移，使 `approvals` 也能在创建时拿到 `notify` |
| bootstrap | `src/bootstrap/startup.ts`（新） | `recoverOnStartup({project, dispatcher, logger})`：逐项目清残留占用 + 补处理排队消息（D18-③），单项目失败不影响其它；`main.ts` 调它一次 |
| bootstrap | `src/bootstrap/main.ts` | 启动自检改为调用 `recoverOnStartup`（原内联逻辑删除）；**放在 `listen` 之后且不阻塞**（`void … .catch(warn)`）——补处理会跑真实回合，放在 listen 之前会把 HTTP 服务一起挡住（实测：前端 vite 代理持续 `ECONNREFUSED 127.0.0.1:3000`） |
| application | `src/application/dispatcher/dispatcher.ts` | `resumeQueued` 由"逐个 `await drain`"改为"**逐 Agent 只排不 await**"——否则第一个卡在"等用户答复"的 Agent 会挡住后面全部（实测：`architect_1` 提问后 `pm_1`/`dev_1` 永远轮不到）；返回的 `resumed` 语义变为"已排" |
| application | `src/application/approval/approval-service.ts` | `decide` 在**无等待者**时 `notify` 申请者（`[审批] 你的申请已被批准/拒绝：<summary>…`）；新增 `logger`/`notify` 依赖 |
| tests | `tests/integration/server/nested-wake-deadlock.test.ts`（新）、`tests/integration/server/restart-recovery.test.ts`（新 3） | 见 §4 |
| docs | `prd`（**D50** + FR-14/FR-29 补注）、`agent-runtime.md` §2、`sandbox.md` §5、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s47` | 全链路回写 |

**未改**：keyed lock 实现（不引入重入，改为"不在回合内嵌套 drain"）；`POST /messages` 的等待语义；S21/D27"平台不判定未完成回合"；S46 的按会话发送状态。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| **死锁先复现** | 新增 `nested-wake-deadlock.test.ts`（pm 派单 → dev 领取并汇报 → 委派人被唤醒并继续）：**修复前超时 12s 失败**（"等待超时：委派人收到回报并继续"），修复后 **350ms 通过** |
| **反向验证** | 临时把 `wake` 改回 `await dispatcher.drain(...)` → 用例再次超时（实测），确认断言压在缺陷上 |
| 重启恢复 | `restart-recovery.test.ts` **4 passed**：① 造"有队列无占用未暂停"的重启态后 `recoverOnStartup` 返回 `resumed: [p:dev_1]` 且消息被真的处理（`turn_end` 出现、`queued` 归零）；② 无等待者的审批被批准 → 申请者会话出现 `[审批] 你的申请已被批准` 唤醒；③ 接线：逐项目 `reset`+`resume`，单项目失败不中断；④ **一个 Agent 卡在"等答复"不挡别人**：`resumeQueued` 5s 内返回、`qa_1` 回合跑完、`architect_1` 进入 `waiting/question`——**反向验证**：退回"逐个 await"该用例 20s 超时（已实测） |
| 启动自证 | 临时数据目录 + 备用端口 3101 启动 → `/health` **200**（改动不会导致起不来） |
| typecheck / eslint | 0 错误（src + web） |
| 全量测试 | `npm test` **63 files / 392 tests 全绿**（S46 基线 61 / 387） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-D_xpswc1.js`，gzip 431.31 kB） |
| **未覆盖** | 真实"崩溃—重启"由用户点验：重启开发服务后应看到各 Agent 队列被自动处理、待审批项决定后申请者被唤醒 |
| 说明 | 与 S15~S46 的交付口径一致 |

## 5. 现场恢复建议（给用户）

1. **重启开发服务**（`npm run dev` / `tsx watch`）。重启后启动自检会：清掉崩溃遗留占用 → **自动补处理所有排队消息**（这个项目 11 条）。原本"永远工作中"的 `pm_1` 会回到 idle 并继续处理它的队列。
2. 那条 **pending 审批**（`dev_1` 的内联命令）重启后等待者已消失，批准/拒绝**不会再续跑被中断的那一回合**（S21/D27：平台不判定未完成回合）；但**决定本身会落盘 + 唤醒 dev_1**（本次修复），dev_1 会在新回合里据此继续或重新发起。
3. 想立刻清空"僵尸待批"，直接在右栏「审批」里批准/拒绝即可。

## 6. 遗留

- **死锁只解决"已知路径"**：本次把唯一会在回合内嵌套 drain 的路径（`wake`）改为异步；如果在别处再写"回合内 await 另一个 Agent 的 drain"，仍会死锁。已在 `wake`/`drain` 注释里写明硬约束；更彻底的方案是给 keyed lock 加重入/超时检测（属基础设施改动，未做）。
- **重启后不续跑被中断的半截回合**：S21/D27 的既定口径（平台不判定未完成回合）；被中断的回合只能靠 Agent 在新回合里用 `session_recent` 自查 + `ask_user`。启动补处理只保证"排队消息不躺尸"。
- **启动自动补处理会真的跑起来**：处理的是用户已发出的排队消息（预期行为），暂停中的 Agent 跳过；若希望"启动只提示、不自动跑"，需要 UI 强提示方案（D18-③ 的另一半）。
- **`tsx watch` 每次保存都重启**：开发期这会打断进行中的回合（本次事故的助推因素）。要避免，可用稳定启动方式（`npm start`，无 watch），或把 watch 范围限制到源码目录之外。
- **实测现场（修复上线后）**：重启后 HTTP 立刻可用（不再 `ECONNREFUSED`），三个原本"躺尸"的 Agent（`pm_1` 从 06:53 卡住）恢复运行；`architect_1`/`pm_1` 在提问（等用户在各自会话里答复），`dev_1` 在等一条命令审批。
