# 修改记录 · 重构 P3c：`loop-runner` 阶段拆分 + 会议守卫接线

> 日期：2026-09-14 · 阶段：P3c（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化）
> 上接：[p3b](2026-09-14-refactor-p3b.md)

## 目标

1. 接完 `MeetingService` 剩余的 3 处流转守卫（P3b 已把守卫归位 domain，接线是机械动作）；
2. 按 P3b 记录的判断推进 `loop-runner.ts`（"那里是真实逻辑，比装配体更值得拆"）。

## 改动范围

| 新增 | 行数 | 内容 |
| --- | --- | --- |
| `application/agent-loop/loop-helpers.ts` | 68 | 上限常量、收尾提示词、闭包工具集、`SKIPPED_TURN`，以及 `parseToolArgs`/`cut`/`summarizeValue` |
| `application/agent-loop/step-streamer.ts` | 76 | `streamStep()`：单步模型流的累积与实时推送 |
| `application/agent-loop/history-builder.ts` | 62 | `buildHistory()`：日志窗口 → 发给模型的对话消息 |

| 修改 | 说明 |
| --- | --- |
| `application/agent-loop/loop-runner.ts` | **861 → 680 行**；三块改为薄包装调用 |
| `application/meeting/meeting-service.ts` | 接线 `canMemberRespond`/`canAskUser`/`canSpeakTurn`（至此 7 处守卫全部走 domain） |

## 关键实现

### 1. `loop-runner` 的三次"单块提取"

按 P3a 定下的纪律——**一次一块、拆完立即 `tsc` + 全量测试**——依次抽出：

| 块 | 为什么它适合独立 |
| --- | --- |
| `loop-helpers` | 全是**不依赖 runner 实例**的常量与纯函数（JSON 解析、截断、审计摘要） |
| `step-streamer` | 只依赖"网关 + 事件总线 + 本轮标识"，与回合状态机无关 |
| `history-builder` | 纯转换：日志窗口 → 对话消息；两条产品语义（他人发言可见、系统消息标注来源）写在它自己的注释里 |

`streamStep` / `buildHistory` 在 runner 内保留同名薄包装，因此调用点一处未改，行为逐字一致
（累积顺序、推送时机、`tools` 为空传 `undefined`、`kind==='message'` 过滤等细节均未动）。

### 2. 会议守卫全部接线

P3b 已把 9 个守卫归位 `domain/fsm/meeting-state.ts`，本轮接完最后 3 处：

| 方法 | 现在的判定 |
| --- | --- |
| `respond` | `canMemberRespond({state, member, host, members, decided})`（一次覆盖状态/在册/未回应三条） |
| `askUser` | `canAskUser({state, asker, host, hasPendingDecision})` |
| `speakTurn` | `canSpeakTurn({state, host, caller, member, agents})` |

service 侧统一用 `assertGuard(err)` 包成 `AppError`；**错误码与中文文案逐字保留**。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过 |
| `npx eslint .` | ✅ 0 error / 6 warning |

> 备注：本轮全量耗时在 22~31s 间波动，个别用例（`code-channel-m8c` 的 workdir_edit 用例）
> 在负载高时偶发 5s 超时，**单独运行稳定通过**。属既有测试对并发负载敏感，非本次改动引入。

## 当前超标文件（5 → 5，但最大者显著下降）

| 行数 | 文件 | 变化 |
| --- | --- | --- |
| 998 | `application/tools/service-tools.ts` | 未动（P3a 回滚后待按"少数大块"重做） |
| **680** | `application/agent-loop/loop-runner.ts` | **861 → 680**（本轮） |
| 692 | `application/composition.ts` | 未动 |
| 656 | `application/meeting/meeting-service.ts` | 守卫归位（规则进 domain，行数基本不变） |
| 422 | `application/question/question-service.ts` | 未动 |

## 下轮建议

1. **`loop-runner` 还可再拆两块**：`execToolCalls`（约 110 行，工具执行+审计+空转检测）与
   `runWrapUp`（约 40 行，收尾回合）。二者都是独立阶段，边界清晰。
2. **`service-tools.ts` 按"少数大块"重做**：切成 3 块（记忆+检索 / 写通道 / 平台交互），
   而不是 7 个细粒度文件——边界越少，出错面越小（P3a 的教训）。
3. `question-service.ts`（422）与 `meeting-service.ts`（656）在其后。
