# 修改记录 · 重构 P3b：超大文件拆分（第二块）——组合根文案与判定归位

> 日期：2026-09-14 · 阶段：P3b（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化）
> 上接：[p3a](2026-09-14-refactor-p3a.md)（`service-tools` 拆分失败并回滚、`loop-runner` 首块抽出）

## 目标与策略调整

P3a 的失败教给我一条：**不要用解析器拆 TS 源文件，也不要一次拆太多**。
本阶段改为 P3a 记录里写下的正确做法——"**一次拆一块、拆完立即 `tsc` + 跑测试**"，
并且只挑**自包含**的块（纯函数、独立模块）。

## 改动范围

| 新增 | 行数 | 来源 | 性质 |
| --- | --- | --- | --- |
| `application/meeting/meeting-prompts.ts` | 103 | `composition.ts` 内联文案 | 纯函数（会议提示词与触达文案） |
| `application/meeting/meeting-attendance.ts` | 48 | `composition.ts` 的 `meetingReadyFor` | 依赖注入的只读判定工厂 |
| `application/task/task-notices.ts` | 58 | `composition.ts` 的任务钩子文案 | 纯函数（任务栏通知文案） |

| 修改 | 说明 |
| --- | --- |
| `application/composition.ts` | **766 → 692 行**；删除 2 处内联文案块、1 处本地纯函数、1 处内联判定 |

## 关键实现

### 1. 会议文案归位（`meeting-prompts.ts`）

`composition.ts` 里 `runMeetingChain` 的 4 段提示词 + `meetingInviteText` + 模块级
`meetingWrapUpText`，合计约 75 行文案。抽出后组合根只剩"何时发、发给谁"的编排：

```ts
const hostOpen = meetingHostOpenPrompt({ host, topic, desc, members })
const hostWrap = meetingHostWrapPrompt({ topic })
const p = meetingMemberSpeakPrompt({ host, topic, desc })
```

`MeetingBrief` / `ShedBrief` 用**最小投影**声明，不把 `MeetingRecord` 整个拖进纯函数。

### 2. 开场门判定（`meeting-attendance.ts`）

`meetingReadyFor` 原先是个闭包，直接捕获 `sessionStore`/`approvals`/`questions`。
改为**依赖注入的工厂**后它可独立构造与断言：

```ts
export function createMeetingReadyCheck(deps: MeetingAttendanceDeps)
  : (pid, mid, members) => Promise<string[]>
```

判定口径逐字保留：① meta 里没有 `accept` 决定 → 未就绪；② 有待批审批或待答提问 → 未就绪。

### 3. 任务栏通知文案（`task-notices.ts`）

`notifyClaim` / `notifyDelegator` 两个钩子里的长文案抽成 `taskClaimNotice(task)` 与
`taskDelegatorNotice({ task, event, by })`；组合根只留"发给谁 + `if creator===user` 跳过"的逻辑。

### 4. 一条自我约束（P3a 的教训）

本阶段我一度在 `meeting-prompts.ts` 里**凭印象写了一段 `meetingYieldText`**——
回去核对原文后确认**原文与我写的不一样**，立即删除。

**规则：抽文案必须逐字复制原文，不能凭记忆重写。** 文案改动即行为变更，不属于纯重构。

### 5. 会议流转守卫归位 domain（P2b 的实质进展）

把 `MeetingService` 的守卫判定归位到 `domain/fsm/meeting-state.ts`，形态与既有
`task-state.ts` 一致——**返回 `{code, message}`（null = 通过）**，由 service 包成 `AppError`：

| 守卫 | 判定 |
| --- | --- |
| `canRespond(state)` | 仅 `proposed`/`open`/`queued` 可回应邀请（queued 允许回应但不占槽） |
| `canMemberRespond({state, member, host, members, decided})` | 在册 + 未回应过 |
| `canAskUser({state, asker, host, hasPendingDecision})` | 仅主持人 + 仅 open + 至多一个待答复 |
| `canAnswerDecision(state)` | 仅 `blocked_waiting_user` |
| `canCancel({state, actor, host})` | 仅 queued/proposed + 仅发起者或用户 |
| `canSpeakTurn({state, host, caller, member, agents})` | 仅主持人 + 仅 open + 被点名者须是参会成员（非主持人） |
| `canUserInterject(state)` | 仅 open / blocked_waiting_user |
| `canClose(state)` | 仅 open / blocked_waiting_user |
| `isMeetingClosed(state)` | 纪要读取/重生成/转任务的共同前提 |

已在 service 侧接线 **4 处**（`answerDecision` / `cancel` / `userInterject` / `close`），
并顺手删除 `cancel` 里因守卫合并而冗余的 actor 判断。**错误码与中文文案逐字保留。**
其余 3 处（`respond` / `askUser` / `speakTurn` 的参数组装）留待下轮接线——
其 domain 侧守卫已就绪，接线是纯机械动作。

> 说明：`meeting-service.ts` 行数仍是 652——因为 `assertGuard(...)` 是**内联展开**，
> 原先是 2~3 行的 `if + throw`，现在 1 行调用，净减有限。
> 这一步的价值在于**规则归位 domain（可单测）**，而不在行数。

### 6. 会议服务无锁（记录，未修）

调研发现 `MeetingService` **没有任何锁**：`create` 的"占槽检查（`activeCount`）"与
`writeMeta` 之间没有互斥，并发发起理论上可产生两场 `proposed`，违反"同一时刻一个会议"的不变量。
**这是既有缺陷，不属纯重构范围**，本轮只记录、不改动（改动即行为变更，需独立方案与测试）。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过，22.9s |
| `npx eslint .` | ✅ 0 error / 6 warning（与 P4 持平） |

每抽一块都单独跑过 gates，未出现 P3a 那种"一次生成多个文件再修"的情况。

## 当前超标文件（6 → 5）

| 行数 | 文件 | 状态 |
| --- | --- | --- |
| 998 | `application/tools/service-tools.ts` | 待按"少数大块"重做（P3a 已回滚） |
| 797 | `application/agent-loop/loop-runner.ts` | 已抽出 `turn-reminders`；可继续按阶段拆 |
| **692** | `application/composition.ts` | 本轮 766→692；剩余为 `composeServices` 的装配体（约 550 行） |
| 652 | `application/meeting/meeting-service.ts` | 含 P2b 的 7 处流转守卫 |
| 422 | `application/question/question-service.ts` | 略超，最后处理 |

### 关于 `composition.ts` 的剩余部分

剩下的 692 行里约 550 行是 `composeServices` 的字段装配序列（`new XxxService(...)` 及其钩子闭包）。
**继续拆它需要把依赖图切片**（例如"会议域构造"独立成模块），那是一次较大的结构改动，
且收益主要是行数而非可读性（装配根本来就是"知道一切"的地方）。
建议：**先做 `loop-runner` / `meeting-service` 的阶段与守卫拆分**（那里是真实逻辑），
`composition.ts` 留到最后评估是否值得再切。
