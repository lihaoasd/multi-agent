# 开发方案 · S3 会话与单工调度（含 WS 网关）

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s3-sessions-dispatcher.md)
> 关联：[data-storage.md](../design/data-storage.md)（§4 会话文件、§9 轮转）、[agent-runtime.md](../design/agent-runtime.md)（§2 单工状态机、§7 恢复）、[contract.md](../api/contract.md)（会话/消息 + WS 协议）、[abstraction.md](../design/abstraction.md)（§4.1/§4.3/§4.6）

## 1. 目标与范围

把"对话 → 落盘 → 推送 → 单工调度 → 恢复"这条主干打通：会话文件体系、seq 分配与轮转、occupancy 真相、消息入队、WS 实时通道。**真正的模型/工具执行仍属 S4**，本阶段用一个显式的**占位回合执行器**把链路跑通并可验收。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `SessionMetaStore` / `SessionLogStore`（seq 分配、跨段单调、逐行容错、轮转）、`EventPipeline`（先盘后推唯一咽喉） | agent loop、上下文组装、工具执行、模型流式（S4） |
| `Dispatcher`：occupancy 唯一真相、`lastHandledSeq` 游标、队列=未处理消息、暂停/恢复、`resumeQueued` | 停止生成/停止任务（S8）、未完成回合的"续做/忽略"三选 UI（D17-⑤，S8） |
| WS 网关：连接、订阅、`ping`/`send` 上行，`event.appended`/`message.commit`/`agent.state` 下行 | 会话内的 3 栏工作台与工作日志折叠（S7）、未读基线 `ack`（P1） |
| 会话路由：列表/详情/日志（按 kind 过滤）/发消息；暂停/恢复；`resume-queued` 恢复入口 | 任务/询问/审批三列表（S6） |
| 前端：项目详情页「会话」页签（左会话列表 + 中事件流 + 发送框 + 暂停/恢复 + WS 连接状态） | 画布与拓扑导航（S7） |

## 2. 关键决定

1. **先盘后推收敛成唯一咽喉**：所有写事件都必须走 `EventPipeline.append`（`SessionLogStore.append` 落盘拿到 seq → 再广播 `event.appended`，`message` 事件额外广播 `message.commit`）。落盘失败则**不广播**（有单测守着顺序）。
2. **队列不另存**：队列 = 日志中 `seq > lastHandledSeq` 的未处理用户消息。好处是重启后无需额外恢复机制；`queued` 在状态投影里由日志与游标派生。
3. **游标在回合结束后推进**（至少一次语义）：崩溃时宁可重放消息，也不丢消息。启动时清理进程遗留的 occupancy（`resetStaleOccupancy`），但**不自动续跑**未完成回合——按 D17-⑤/§7 留给 S8 的恢复入口。
4. **`queued` 的语义修正**：`submitUserMessage` 最初把 `queued` 等同于"忙"，导致**暂停中的 Agent** 明明没被处理却返回 `queued=false`。改为 `queued = !processed`（忙与暂停两条路径都算入队）——由 S3 用例抓出。
5. **会话按项目定位**：`SessionLogStore`/`SessionMetaStore` 的签名相比 abstraction §4.6 增加了 `projectId`（会话文件本就在项目目录内），避免为定位文件而全盘扫描；`FileStore` 增加 `move`（轮转需要原子改名）。
6. **测试装配必须与生产同构**：测试 helper 原先注入"纯录制广播器"，导致服务事件不进 WS Hub（WS 用例失败）。改为"录制 + 转发到真实 Hub"，既保留断言能力又走通推送链路。
7. **占位执行器**：`createPlaceholderTurnRunner` 只写 `turn_start → thought → message(agent) → turn_end`，事件形状与真实回合一致；S4 替换它时前端与投影代码无需改动（文件将删除）。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S3.1 端口 | `ports/session.ts`（meta/log/事件类型/`SessionSummary`）、`ports/dispatcher.ts`（`DispatcherState`/`DispatcherStateStore`/`Dispatcher`/`AgentStatus`）、`ports/turn.ts`（`TurnRunner`）；`ports/events.ts` 增 `WsRealtime`；`ports/file-store.ts` 增 `move`；tokens 15 → 20 |
| S3.2 infra 存储 | `infra/file-store/session-meta-store.ts`、`session-log-store.ts`（seq/轮转/容错）、`dispatcher-state-store.ts`（runtime.state + 坏文件备份） |
| S3.3 infra 实时 | `infra/events/ws-hub.ts`（客户端注册表 + 按 projectId 路由广播） |
| S3.4 application | `application/session/{event-pipeline,session-service,session-meta-factory}.ts`、`application/dispatcher/dispatcher.ts`、`application/agent-loop/placeholder-runner.ts` |
| S3.5 server | `server/http-routes/sessions.ts`、`server/ws/gateway.ts`；`app.ts` 接入（含 WS 注册）；`projects.ts` 创建项目/增成员时建会话、停启用时同步会话归档 |
| S3.6 装配 | `composition-root.ts`：8 个新 Token 注册 + `EventPipeline`/`SessionService`/`Dispatcher` 装配；广播器默认换成 WS Hub；`main.ts` 启动清理陈旧占用 |
| S3.7 前端 | `web/src/api/sessions.ts`、`web/src/hooks/useRealtime.ts`、`web/src/pages/SessionPanel.tsx`；项目详情页改为「团队与配置 / 会话」两个页签 |
| S3.8 测试 | 新增 4 个文件 25 条：`session-log-store`(7)、`event-pipeline`(3)、`sessions-api`(8)、`ws-gateway`(6)；另修正 1 条 S2 用例（`/agents` 投影语义升级） |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc`（服务端 + 前端） | 0 错误 |
| 测试 | `vitest run` | **22 files / 147 tests 全通过**（S3 新增 25 条） |
| 门禁 | `eslint .` + ratchet | exit 0；越层违规 0 |
| 真实服务验收（规则 1/5/9） | 起服务（3100）+ 真实 WS 客户端 | 项目创建即建 8 条会话 ✓；WS `ws.ready`/`ping→pong`/`send` ✓；事件顺序 `#1 message → #2 turn_start → #3 thought → #4 message → #5 turn_end` ✓；`message.commit #1 #4` ✓；`agent.state working → idle` ✓；第二条消息进 turn=2 ✓ |
| 单工与队列 | 暂停 → 发消息 → 恢复 | 暂停后 `queued=true`、日志只有 `message`；`resume` 返回 `handled:1` 并补齐 `turn_start/thought/message/turn_end` ✓ |
| 落盘证据 | `runtime.state.json` + JSONL | `occupancy {}`、`lastHandledSeq {dev_1:6, qa_1:1}`、`turns {dev_1:2, qa_1:1}`；日志行含 `seq/ts/sessionId/turn/kind` + 平铺 payload ✓ |
| 会话文件布局 | `projects/<pid>/sessions/` | 每会话 `<sid>.meta.json` + `<sid>.log.jsonl`；轮转后为 `.log.<n>.jsonl` ✓ |
| REST 发消息 | curl（UTF-8 原文） | `202 {seq:1,queued:false}` → 日志 5 条事件；`kind` 过滤生效 ✓ |
| 前端 | `vite build` + 类型检查 | 构建成功；项目详情页新增「会话」页签（WS 状态条 + 事件流 + 发送框 + 暂停/恢复） |

## 5. 不做与遗留

- **未完成回合的恢复**（缺 `turn_end` → UI 三选"汇报中断点/续做/忽略"）留 S8；本轮只做到"清掉陈旧占用 + 不自动续跑 + 提供 `resume-queued` 入口"。
- 流式 `message.chunk` 未产生：占位执行器不是流式；S4 接入模型流式后由 `ModelGateway` 的增量驱动。
- `ack`/未读基线（P1）、`hangup`（P1）未做。
- 暂停中的 Agent 若当前回合正在跑：本阶段占位回合极短，未实现"到可中断点挂起"的中断点机制（S8 与 stop 一起做）。
- 端口 3000 仍被旧的 14:29 实例占用（非本轮），验收统一用 3100。
