# 修改记录 · 重构 P2a：领域逻辑归位（domain 从 2 → 6 个文件）

> 日期：2026-09-14 · 阶段：P2（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化、无数据格式变化）

## 需求/问题

用户最初的反馈是"模块混乱、不好区分，抽象设计不足"。P0/P1 解决了存储与分层规则；
P2 解决**领域逻辑混在 application 层**的问题——`architecture.md` §1 承诺"domain 层纯逻辑可单测"，
但重构前 `src/domain/` 只有 2 个文件，状态机全部内联在 service 里。

## 改动范围

| 新增（domain） | 来源 | 说明 |
| --- | --- | --- |
| `domain/fsm/agent-state.ts` | `application/runtime-state.ts`（已删除） | 角色运行态推导：停用 > 会议 > 等待 > 工作 > 空闲 |
| `domain/rules/path-boundary.ts` | `infra/file-store/fs-utils.ts` | `isPathInside` / `ensureInside`（纯路径边界规则） |
| `domain/fsm/task-state.ts` | `application/task/task-service.ts` 内联 | 状态常量、流转表、单工槽位、去重归一化、协调者判定 |
| `domain/fsm/meeting-state.ts` | `application/meeting/meeting-service.ts` 内联 | 状态集合、占槽判定、两态呈现派生 |
| `domain/fsm/approval-state.ts` | `application/approval/approval-service.ts` 内联 | 状态集合（pending 终态性）+ `decide` 守卫 |

| 修改 | 说明 |
| --- | --- |
| `application/task/task-service.ts` | 删掉内联流转表/`normalizeTitle`/`isCoordinator`/两处"单工槽位"查找，改调 domain；保留同名 re-export |
| `application/meeting/meeting-service.ts` | `meetingDisplayState` 等改为从 domain import + re-export |
| `application/composition.ts`、`server/app.ts`、`agent-loop/loop-runner.ts` | `deriveAgentState` 导入路径改指 domain |
| `infra/file-store/fs-utils.ts` | `ensureInside`/`isPathInside` 改为从 domain re-export（消除 domain→infra 反向依赖） |
| `application/artifact`、`application/tools/service-tools` | `ensureInside` 直接从 domain 导入 |
| `eslint.config.js` | domain 规则从"禁所有 `node:*`"收紧为"**只禁 IO 类内置模块**" |
| `tests/domain-agent-state.test.ts` | 导入路径改指 domain（**断言一行未改**） |

## 关键实现与判断

### 1. 修掉一条真实的分层违规（domain → infra）

`domain/rules/path-resolver.ts` 原先从 `infra/file-store/fs-utils.ts` 导入 `isPathInside`
——**domain 反向依赖 infra**，是 P0 规则抓到的 50 处违规之一。

修法不是"把 domain 文件挪走"，而是认清：`isPathInside`/`ensureInside` 是**纯路径规则**，
权威定义本就该在 domain。于是：

```
domain/rules/path-boundary.ts   ← 权威定义（纯运算）
   ↑ re-export                 ↑ re-export
infra/file-store/fs-utils.ts   application/*（artifact、service-tools）
```

方向变为"infra 复用 domain"，符合分层。

### 2. 一条被我写错的规则：domain 禁 `node:*` 过严

P0 时我给 domain 写了"不得使用 Node 内置模块"。P2 落地 `path-boundary.ts` 时它立刻报错——
但对 `node:path` 的**纯字符串运算**恰恰应该是允许的：它不是 IO、无需端口抽象。

**过严的规则会逼着把纯逻辑赶到 infra，反而造成 domain→infra 反向依赖**（正是上面第 1 条的病根）。
因此收紧为只禁 IO 类：`node:fs` / `node:child_process` / `node:net` / `node:http(s)` / `node:dgram` /
`node:worker_threads` / `node:cluster` / `node:v8` / `node:vm`。

### 3. 行为等价的做法：规则搬走、文案留在原地

判定规则进 domain，但**错误码与中文文案逐字不变**，由 service 包成 `AppError`。例如
`taskTransitionError(from, to)` 返回与既有实现完全一致的拒绝原因字符串：

```
非法状态流转 ${from} → ${to}（允许: ${allow.join(', ') || '无（终态）'}）
```

这样 REST 契约与测试断言都不受影响（`tasks-m8b` / `task-board-m8m` / `task-dedup-m8n` /
`task-completion-m8p` 26 个用例保持通过）。

### 4. 一处我自己引入并修掉的错误

`meeting-service.ts` 里我最初写 `export { meetingDisplayState } from '…'`，
但该写法**不会把名字引入本地作用域**，导致同文件的 `withDisplay` 报 `Cannot find name`
（7 个测试文件、15 个用例失败）。改为**先 `import` 再 `export`** 后恢复。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过，22.0s |
| `npx eslint .` | ✅ 0 error / **11 warning** |

分层违规累计收敛：**50（P0 起点）→ 30（allowTypeImports）→ 15（util/id 上移）→ 13 → 11（P2）**。
`src/domain/` 文件数：**2 → 7**（`agent-state` / `approval-state` / `meeting-state` / `task-state`
+ 已有的 `command-policy` / `path-boundary` / `path-resolver`）。

审批状态机一并归位：`ApprovalService.decide` 原先内联的 `if (rec.status !== 'pending')`
改为调用 `approvalDecideError()`，**拒绝文案逐字不变**（`tools-m3` / `approval-blocking-m8v` /
`artifact-m4` 共 24 个用例保持通过）。

## 遗留（P2 后续）

| 项 | 说明 |
| --- | --- |
| `meeting-service.ts` 的**流转守卫** | `respond`/`askUser`/`answerDecision`/`cancel`/`close`/`speakTurn`/`userInterject` 的判定仍内联（约 7 处）。这是 P2 剩下的最大一块，且 `MeetingService` 没有锁（`create` 的占槽检查与 `writeMeta` 之间无互斥）——抽取时要把并发问题一并记录 |
| `approval-service` 的 allow/approval/deny 判定 | 目前规则已在 `domain/rules/command-policy.ts`，其余审批状态判定仍在 service |
| `turn-state`（回合挂起/空转/收尾判定） | 在 `loop-runner.ts` 内联，P3 拆该文件时一并处理 |
| `domain/events` | 事件 kind 与 payload 契约仍在 `shared/types/session.ts`（P3 评估是否需要迁移） |
| `domain/rules/path-resolver.ts` | 按 `architecture.md` §4 应属 `infra/sandbox`；但它纯逻辑且被 domain 内使用，是否迁移留待 P3 评估（当前无违规） |
