# S38 方案：询问等待的状态语义（「等待回复中」）+ 等待态及时刷新

> 日期：2026-09-16　类型：用户口径（"角色询问，应该是等待回复中"）　真源：`design/agent-runtime.md` §2、`design/ui.md` §3/§4、`api/contract.md`、`prd.md` US-4 / FR-29
> 关联：`docs/changes/2026-09-16-s38-waiting-for-question.md`、`docs/plan/development.md`

## 1 需求

用户口径：**角色在询问时，状态应该是「等待回复中」。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 等用户答复询问时，界面明确显示**「等待回复中」** | 会话左栏、拓扑节点、运行细条的徽标都显示「等待回复中」（不是笼统的「等待中」） |
| R2 | 等审批时**不能**混为"等回复" | 显示「等待审批中」（`waitingFor:'approval'`） |
| R3 | 状态要**及时**变过来 | Agent 开始询问后，界面立刻从「工作中」变为「等待回复中」，不需要用户手点刷新 |
| R4 | 答复后回到正确状态 | 答复后回到「工作中」，回合收尾后「空闲」 |
| R5 | 状态口径三处同源 | 左栏 / 画布节点 / 运行细条共用一份映射（此前是三份 `Record<state, label>` 各写一遍） |
| R6 | 不改数据与接口语义 | `state` 三态不变，只**增补**一个 `waitingFor` 投影字段 |

## 2 现状与根因（两个问题叠在一起，缺一个都看不到「等待回复中」）

| # | 位置 | 问题 |
| --- | --- | --- |
| ① | `GET /agents` 的状态投影（`dispatcher.statusOf`） | `waiting` **只说明"卡住了"**：等用户答复与等审批被压成同一个值，界面无法区分，只能显示笼统的「等待中」（而用户要看的是"等**我回复**"） |
| ② | 前端刷新时机 | `agent.state` 帧**只在回合开始（working）/ 结束（idle）/ 暂停 / 清理占用时**由 dispatcher 广播；**"进入等待"没有任何帧**（询问由 `question.asked`、审批由 `approval.requested` 广播，它们不是 `agent.state`）。而左栏与画布只认 `agent.state`（`SessionPanel` L207、`TopologyPanel` L70）→ Agent 明明在等答复，界面仍挂着上一个「工作中」，直到用户切换会话/发消息才被动刷新 |

> 根因 ② 是用户"看不到等待回复"的直接原因；根因 ① 决定了即便刷新也只会显示「等待中」。两个都修才算交付。

## 3 关键决定

1. **加一个投影字段而不是改状态机**：`AgentStatus`/`RuntimeAgentView` 增 `waitingFor: 'question' | 'approval' | null`（`state` 仍是 `idle/working/waiting` 三态，落盘真相仍是 `occupancy`）。这样「等什么」由后端一处算清，界面不做二次推导（前端要推导就得同时拉项目级询问+审批两张表）。
2. **界面三处同源**：抽纯函数 `web/src/lib/agent-state.ts` 的 `agentStateView(status)`——`paused` 优先（叠加开关压过三态），`waitingFor='question'` → **等待回复中**（orange）、`'approval'` → **等待审批中**（gold）、未知 → 「等待中」兜底、未知 state 原样透出。会话左栏、画布节点、运行细条都改用它（删掉三份重复映射）。
3. **刷新靠"进入等待"的事件补**：不新增 `agent.state` 帧（那要求询问/审批服务也去算占用投影，容易与 dispatcher 漂移）；改为前端在 `question.asked/answered`、`approval.requested/decided` 时**也刷新状态**——这几类帧本来就在推，只是没被用来刷新状态。
4. **保留向后兼容**：`waitingFor` 在前端类型里是可选字段，旧帧/缺字段时退回「等待中」，不白屏、不报错。
5. **不动会话流与答复入口**：S32/D35 的"发送框上方答复卡"不变；本轮只解决"状态怎么说"。

## 4 实现步骤

- `src/ports/dispatcher.ts`：新增 `AgentWaitingFor` 类型；`AgentStatus` 增 `waitingFor`。
- `src/application/dispatcher/dispatcher.ts`：`statusOf` 里把原来的 `||` 短路拆成两个布尔（`waitingApproval`/`waitingQuestion`），得出 `waitingFor`，`state` 按 `waitingFor` 是否为 `null` 派生。
- `src/ports/runtime.ts` + `src/application/runtime/runtime-service.ts`：`RuntimeAgentView` 增 `waitingFor` 并透传；`src/server/http-routes/projects.ts` 的 `/agents` 透传。
- `web/src/api/{sessions,runtime}.ts`：类型补可选 `waitingFor`。
- `web/src/lib/agent-state.ts`（新）+ `SessionPanel`/`TopologyPanel`/`WorkingBar` 改用；两处实时回调补"询问/审批帧也刷新状态"。
- 测试：`tests/unit/web/agent-state.test.ts`（6）、`tests/integration/server/question-waiting.test.ts`（1，走真实 loop：`ask_user` → 投影 `waiting/question` → 答复 → 回 `idle/null`）。
- 文档回写：`prd` **D41** + US-4 补注、`agent-runtime.md` §2、`ui.md` §3/§4、`contract.md`（`/agents` 与 `/runtime` 字段）、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s38`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `agent-state.test.ts` 6 条：等答复 / 等审批 / 原因缺失兜底 / 工作中 / 空闲 / 暂停优先 / 未知 state 透出 |
| 集成 | `question-waiting.test.ts`：脚本化网关驱动真实 loop 调 `ask_user` → `GET /agents` 断言 `{state:'waiting', waitingFor:'question'}` → 答复 → 回 `{state:'idle', waitingFor:null, queued:0}` |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `npm run build` |
| **用户点验** | ① 让某个 Agent 提问 → 左栏/画布徽标应显示**「等待回复中」**（且**立刻**变，不用手动刷新）② 在会话窗口答复 → 徽标回到「工作中」→ 收尾后「空闲」 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 前端刷新频率变高（询问/审批帧触发状态拉取） | 状态接口是本地文件投影、按项目一次返回；且这些帧本来就是低频人工动作 |
| 旧客户端/缺字段 | `waitingFor` 可选，缺失时退回「等待中」 |
| 等审批被误标为"等回复" | 后端 `waitingFor` 明确区分，单测覆盖 approval 分支 |
| 三处界面口径再次分叉 | 只保留一个纯函数 `agentStateView`，三处引用，单测钉住文案与配色 |
