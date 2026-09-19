# 修改记录 · S38 询问等待的状态语义（「等待回复中」）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s38-waiting-for-question.md](../plan/2026-09-16-s38-waiting-for-question.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §2、[ui.md](../design/ui.md) §3/§4、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) US-4 / D41

## 1. 需求 / 问题

用户口径：**"角色询问，应该是等待回复中"**。

查下来是**两个问题叠在一起**，缺一个都看不到「等待回复中」：

1. **投影太笼统**：`dispatcher.statusOf` 把"等用户答复询问"和"等审批决定"压成同一个 `state='waiting'`，界面只能显示笼统的「等待中」——用户要看的是"在等我回复"。
2. **状态不及时（真正的直接原因）**：`agent.state` 帧只在回合开始 / 结束 / 暂停 / 清理占用时广播；**"进入等待"没有任何 `agent.state` 帧**（询问走 `question.asked`、审批走 `approval.requested`）。而会话左栏与画布只认 `agent.state` → Agent 已经在等答复，界面还挂着上一个「工作中」，得等用户切会话/发消息才被动刷新。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/dispatcher.ts` | 新增 `AgentWaitingFor = 'question' \| 'approval'`；`AgentStatus` 增 `waitingFor: AgentWaitingFor \| null` |
| application | `src/application/dispatcher/dispatcher.ts` | `statusOf` 把 `waiting` 的 `||` 短路拆成 `waitingApproval`/`waitingQuestion` → 得出 `waitingFor`，`state` 由它派生（`waiting` 仅当 `waitingFor !== null`） |
| ports / application / server | `src/ports/runtime.ts`、`src/application/runtime/runtime-service.ts`、`src/server/http-routes/projects.ts` | `RuntimeAgentView` 与 `/agents`、`/runtime` 一并透出 `waitingFor` |
| web | `web/src/lib/agent-state.ts`（新） | 纯函数 `agentStateView(status) → {text,color}`：`paused` 优先 →「已暂停」；`waiting + question` →**「等待回复中」**（orange）；`waiting + approval` →「等待审批中」（gold）；原因缺失 →「等待中」兜底；未知 state 原样透出 |
| web | `web/src/pages/{SessionPanel,TopologyPanel,WorkingBar}.tsx` | 三处共用一个 `agentStateView`（删掉三份重复的 `Record<state,label>`）；会话左栏与画布在 `question.asked/answered`、`approval.requested/decided` 时**也刷新状态**（补上"进入等待没有 `agent.state` 帧"的缺口） |
| web | `web/src/api/{sessions,runtime}.ts` | 类型补可选 `waitingFor`（缺字段时退回「等待中」，不白屏） |
| tests | `tests/unit/web/agent-state.test.ts`（新 6）、`tests/integration/server/question-waiting.test.ts`（新 1） | 见 §4 |
| docs | `prd`（**D41** + US-4 补注）、`agent-runtime.md` §2、`ui.md` §3/§4、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s38` | 全链路回写 |

**未改**：`state` 三态与 `occupancy` 真相；落盘结构；`GET /agents` 的既有字段；S32/D35 的答复入口（仍在会话窗口发送框上方）；S21/D27 的"平台不判定未完成回合"。

## 3. 关键决定

1. **加投影字段，不改状态机**：`waitingFor` 由后端一处算清。若让前端自行推导，就得同时拉项目级询问表与审批表再按 instanceId 匹配——同一件事两处实现，迟早漂移。
2. **界面三处同源**：只留一个纯函数 `agentStateView`（可单测），左栏 / 画布 / 细条都引用它；此前是三份各写一遍的 `Record<state, label>`。
3. **不新增 `agent.state` 帧**：那要求询问/审批服务也去算占用投影（三处算状态必然漂移）；改为前端在既有的询问/审批帧上补一次状态拉取（这些帧本来就在推，只是没被用来刷新状态）。
4. **向后兼容**：`waitingFor` 在 web 类型里可选，旧数据/缺字段退回「等待中」。
5. **「等待审批中」也一起说清**：同一个 `waiting` 拆成两种说法，否则等审批的 Agent 会被显示成"等用户回复"，反而误导。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 新增单测 | `tests/unit/web/agent-state.test.ts` **6 passed**：等答复→「等待回复中」/ 等审批→「等待审批中」/ 原因缺失→「等待中」/ 工作中 / 空闲（含 `undefined`）/ 暂停优先 / 未知 state 原样透出 |
| **新增集成（端到端）** | `tests/integration/server/question-waiting.test.ts` **1 passed**：脚本化网关驱动真实 loop 调 `ask_user` → `GET /agents` 断言 `{state:'waiting', waitingFor:'question'}` → 答复（`POST /questions/:qid/answer`）→ 回合收尾后回 `{state:'idle', waitingFor:null, paused:false, queued:0}` |
| 全量测试 | `npm test` **57 files / 356 tests 全绿**（S37 基线 55 / 349） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BmNYGCdd.js`（1,373.57 kB / gzip 429.89 kB） |
| **未覆盖** | 前端刷新时机无自动化（无 DOM 测试）：**须用户点验** —— ① 让 Agent 提问，左栏/画布徽标应**立刻**变「等待回复中」② 答复后回「工作中」，收尾后「空闲」 |
| 说明 | 与 S15~S37 的交付口径一致 |

## 5. 遗留

- **`agent.state` 帧仍不覆盖"进入等待"**：本轮用"前端在询问/审批帧上补刷新"绕开；若将来有其它订阅方（外部客户端、通知）需要精确的等待态推送，应在 dispatcher 侧对 `waitingFor` 变化发帧（当前选择是避免三个服务各算一遍占用投影）。
- **画布节点徽标仍额外显示「暂停」小标签**（`paused` 与状态徽标并存）：S19 的既有形态，未动；若要合并成一个徽标（「已暂停」压过三态）需要统一节点卡片的排版。
- **等审批的中文说法**（「等待审批中」）此前无用户口径，属本轮新增文案；若你更希望简化为「等待中」，改 `agent-state.ts` 一处即可（单测同步）。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36/S37 记录）。
