# 修改记录 · S3 会话与单工调度（2026-09-15）

> 类别：changes · 类型：**实现** · 方案：[docs/plan/2026-09-15-s3-sessions-dispatcher.md](../plan/2026-09-15-s3-sessions-dispatcher.md) · 总计划：[development.md](../plan/development.md) §6
> 需求来源：用户"开始全部开发"；本轮落地规则 1（单工不变式）、规则 5（seq 单调/先盘后推/重启重建）、规则 9（turn 边界与轮转），以及 FR-03/FR-04 的存储与调度底座

## 1. 交付内容

| 层 | 新增/修改文件 |
| --- | --- |
| 端口 | `ports/session.ts`、`ports/dispatcher.ts`、`ports/turn.ts`；`ports/events.ts`（+`WsRealtime`）、`ports/file-store.ts`（+`move`）、`ports/tokens.ts`（15 → 20 Token） |
| infra 存储 | `infra/file-store/{session-meta-store,session-log-store,dispatcher-state-store}.ts` |
| infra 实时 | `infra/events/ws-hub.ts`（替换 S1/S2 的 noop 广播器） |
| application | `application/session/{event-pipeline,session-service,session-meta-factory}.ts`、`application/dispatcher/dispatcher.ts`、`application/agent-loop/placeholder-runner.ts` |
| server | `server/http-routes/sessions.ts`、`server/ws/gateway.ts`；`server/app.ts`（WS 注册 + 服务注入）、`server/http-routes/projects.ts`（建会话/同步归档/`/agents` 改用 dispatcher 状态） |
| bootstrap | `composition-root.ts`（8 个新 Token + 管道/会话/调度装配，广播器默认换 WS Hub）、`main.ts`（启动清理陈旧占用） |
| 前端 | `web/src/api/sessions.ts`、`web/src/hooks/useRealtime.ts`、`web/src/pages/SessionPanel.tsx`、`ProjectModule.tsx`（页签化） |
| 测试 | `tests/unit/infra/session-log-store.test.ts`、`tests/unit/application/event-pipeline.test.ts`、`tests/integration/server/{sessions-api,ws-gateway}.test.ts`；`tests/helpers{,-server}.ts`（录制+转发广播器） |

## 2. 关键决定（可推翻）

1. **先盘后推的唯一咽喉**：`EventPipeline.append` = 落盘（分配 seq）→ 广播 `event.appended`（+`message.commit`）。落盘失败不广播，有单测守着。
2. **队列 = 日志中 `seq > lastHandledSeq` 的未处理消息**：不引入独立队列文件，重启后队列天然可重建。
3. **游标在回合结束后推进**（至少一次）：崩溃宁可重放不丢消息；启动时清陈旧 occupancy，但不自动续跑未完成回合（D17-⑤ 留 S8）。
4. **修掉 `queued` 语义缺陷**：原实现 `queued = 忙`，导致**暂停中的 Agent** 消息未被处理却回 `queued=false`。改为 `queued = !processed`。S3 用例抓出并回归。
5. **签名口径偏离（已回写文档）**：`SessionLogStore`/`SessionMetaStore` 增加 `projectId` 参数（会话文件在项目目录内，避免全盘扫描）；`FileStore` 增加 `move`（轮转原子改名）。
6. **测试装配与生产同构**：测试 helper 从"纯录制广播器"改为"录制 + 转发真实 WS Hub"，否则服务事件不进 WS 连接（WS 用例失败暴露了这一点）。
7. **占位回合执行器**：S3 不实现模型/工具执行，用形状一致的事件流（`turn_start→thought→message→turn_end`）打通链路；S4 删除该文件并替换为真实 loop。
8. **轮转不重入锁**：KeyedLock 不可重入，`append` 内的轮转改为无锁内部实现（`rotateLocked`），避免自锁。

## 3. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查（服务端 + 前端） | 0 错误 |
| 测试 | **22 files / 147 tests 全通过**（S3 新增 25 条；另修正 1 条 S2 用例） |
| 门禁 | `eslint .` exit 0；ratchet 越层违规 0 |
| 真实服务验收（含真实 WS 客户端） | 8 条会话自动建立；`ws.ready`/`ping→pong`/上行 `send` 回执；事件顺序 `#1 message · #2 turn_start · #3 thought · #4 message · #5 turn_end`；`message.commit #1 #4`；`agent.state working → idle` |
| 单工与队列 | 暂停后发消息：`queued=true`、日志只有 `message`、状态投影 `paused=true queued=1`；恢复：`handled=1` 并补齐回合事件 |
| 落盘证据 | `runtime.state.json`：`occupancy {}`、`lastHandledSeq {dev_1:6,qa_1:1}`、`turns {dev_1:2,qa_1:1}`；JSONL 行含 `seq/ts/sessionId/turn/kind` + 平铺 payload；会话目录每会话 meta+log |
| REST 路径 | `202 {seq:1,queued:false}` → 5 条事件；`kind` 过滤与 `fromSeq` 增量读取生效 |
| 前端 | `vite build` 成功；项目详情页新增「会话」页签（WS 连接状态、事件流、发送、暂停/恢复） |

## 4. 未做 / 遗留

- 未完成回合恢复 UI（D17-⑤）与"到可中断点挂起"的中断点机制留 S8（与停止生成/停止任务一起做）。
- 流式 `message.chunk` 未产生（占位执行器非流式）；S4 接模型流式后由网关增量驱动。
- `ack`/未读基线、`hangup` 属 P1，未做。
- 端口 3000 仍被 14:29 启动的旧实例占用（非本轮），验收统一用 3100。

## 5. 回滚

```bash
git rm src/ports/{session,dispatcher,turn}.ts \
  src/infra/file-store/{session-meta-store,session-log-store,dispatcher-state-store}.ts \
  src/infra/events/ws-hub.ts src/application/session src/application/dispatcher \
  src/application/agent-loop/placeholder-runner.ts src/server/http-routes/sessions.ts src/server/ws \
  web/src/api/sessions.ts web/src/hooks/useRealtime.ts web/src/pages/SessionPanel.tsx \
  tests/unit/infra/session-log-store.test.ts tests/unit/application/event-pipeline.test.ts \
  tests/integration/server/sessions-api.test.ts tests/integration/server/ws-gateway.test.ts
git checkout HEAD -- src/ports/{events,file-store,tokens}.ts src/server/app.ts \
  src/server/http-routes/projects.ts src/bootstrap/{composition-root,main}.ts \
  tests/helpers.ts tests/helpers-server.ts web/src/pages/ProjectModule.tsx \
  docs/api/contract.md docs/design/{data-storage,abstraction}.md docs/plan/development.md
```
