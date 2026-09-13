# 修改记录 · 重构 P1a：存储抽象落地 + 首批 store 迁移

> 日期：2026-09-14 · 阶段：P1a（`docs/plan/2026-09-14-refactor-architecture.md` 的 P1 前半）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化、无数据格式变化）

## 需求/问题

P0 已把分层写进可执行规则，并量化出 **50 处存量违规**。P1 解决其中最大的一类：
**15 个 store 各自手写一遍 `readFile → split('\n') → JSON.parse`、各自 `atomicWriteFile`、各自加串行锁**
——`architecture.md` §4.1 承诺的 7 个端口里，只有 `ModelGateway` 真实存在。

## 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/ports/storage.ts` | 新增：`JsonlStore` / `JsonStore` / `DirectoryStore` / `StoragePorts` 契约 |
| `src/infra/store/storage-root.ts` | 新增：项目根解析 + 越界校验（`resolve` / `resolveRaw` / `reRoot`） |
| `src/infra/store/file-store.ts` | 新增：端口默认实现（`FileJsonlStore` / `FileJsonStore` / `FileDirectoryStore`） |
| `src/infra/store/project-store.ts` | 新增：`ProjectStore` 门面 + `StorageFacade`（application 层唯一 IO 边界） |
| `src/application/dispatcher/occupancy-store.ts` | 迁移（去 fs，改注入 `ProjectStore`） |
| `src/application/memory/memory-store.ts` | 迁移（同上；`supersede` 改用持锁 `mutate`，消除"读-改-写"窗口） |
| `src/application/artifact/file-owner-store.ts` | 迁移（删除自建 `KeyedLock` 与手写行拼接，锁下沉到端口） |
| `src/application/meeting/invite-store.ts` | 迁移（同上） |
| `src/application/meeting/shed-store.ts` | 迁移（同上） |
| `src/application/composition.ts` | 装配存储端口与门面，注入给上述 5 个 store |
| `eslint.config.js` | 新增 `ports` 层规则；`no-unused-vars` 显式写 `after-used` |
| `tests/infra-store.test.ts` | 新增（25 用例）：端口与门面契约 |
| `tests/meeting-yield-m9a.test.ts`、`tests/memory-m5.test.ts` | 仅改装配 3 行（构造 store 改吃门面） |

## 关键实现

### 1. 端口提到顶层 `src/ports/`（架构修正）

初版把端口放在 `src/application/ports/`，lint 立刻判定 **infra → application 反向依赖**。
这是真问题而非误报：适配器实现应用层定义的接口，方向应是"实现依赖抽象"。

因此端口**上移为独立顶层契约层**：

```
shared（最底）→ ports（契约，只依赖 shared）→ domain / infra / application → server
```

顺带修掉一个尝试：`no-restricted-imports` 的 `patterns.group` **不支持 `!` 取反**
（实测 `['**/application/**','!**/application/ports/**']` 仍会命中 ports），
所以"用取反开例外"这条路不通，只能靠分层位置来消除歧义。

### 2. 端口内建"持锁的读-改-写"

迁移前 `FileOwnerStore.claim`、审批表、任务表各自 `lock.run + readAll + 拼行 + atomicWrite`。
若端口只提供 `readAll`/`append`，调用点会继续自己加锁——抽象就没解决问题。

因此端口提供两种模式：

| 模式 | 端口方法 | 覆盖对象 |
| --- | --- | --- |
| 追加 | `jsonl.append` | 会话日志等 append-only |
| **整体重写（持锁）** | `jsonl.mutate(all => next \| null)` | 归属表、审批表、任务表、记忆表、邀请台账 |
| JSON 读改写（持锁） | `json.mutate(cur => next \| null)` | runtime.state.json、manifest |

返回 `null` = 不写盘（保持迁移前"无变更不落盘"的语义）。

### 3. 行为契约逐条对齐既有实现

`tests/infra-store.test.ts` 把这些语义固化为断言（21 条端口 + 4 条门面）：

1. 文件不存在 = **空集合**，不抛错；
2. JSONL **坏行跳过**（`data-storage.md` §9 损坏容错，逐条对齐 `session-store` 既有行为）；
3. JSON 解析失败**要抛 `ERR_INTERNAL`**（结构化文件损坏不能静默当空）；
4. 写是**原子**的（复用既有 `atomicWriteFile` 的临时文件 + rename + EPERM 重试）；
5. `mutate` 的读-改-写**全程持锁**（20 路并发写回不丢记录，已断言）。

同时保留 `mutate` 写出的**逐字节格式**（每行一条 JSON + 末尾换行），与迁移前各 store 手写格式一致。

### 4. 兼容策略：不改测试断言

硬约束是"257 个用例断言一行不改"。因此门面提供两种寻址：

- `forProject(projectId)` —— 生产路径
- `forProjectsRoot(projectsRoot)` —— 等价于迁移前 `new XStore(projectsRoot)`（内部 `join(root, projectId, …)`）
- `forProjectAbs(绝对项目目录)` —— 等价于 `new XStore(项目目录)`（既有测试场景）

测试改动因此只有 3 行装配 + 2 行 import。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx vitest run tests/infra-store.test.ts` | ✅ **27 用例**（端口 21 + 门面 6） |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过（P0 后 288 + 新增 27） |
| `npm run lint` | ✅ **0 error / 49 warning**（P0 时 0 error / 50 warning） |
| `npm run typecheck` | ✅ 无输出 |

企业行为等价性证据：全量用例全绿，含会话日志、记忆、归属锁、会议邀请/搁置、code-edits 轨迹的既有断言
（其中 `code-channel-m8c`、`tool-loop-m8g` 在 P1b 首轮**确实抓到了作用域 bug**，修好后通过）。

## 过程中修正的两个自身失误（如实记录）

1. **PowerShell 改文件把行尾从 CRLF 改成 LF**，`composition.ts` 的 diff 被放大到 `99 insertions / 140 deletions`。
   已 `git checkout` 恢复，改用 `edit` 工具重做，diff 回到最小。教训：批量文本替换不要用 `Set-Content` 处理本仓库文件。
2. **`MeetingInviteStore.writeAll` 初版写成无条件重写**，与迁移前"无变更不落盘"不等价。
   已改为只在确有变更时写入（`writeChanged`）。

### 追加（P1b 首轮暴露的两个更严重的问题）

3. **`forProjectsRoot` 的作用域假设错了（真 bug，被既有测试抓到）**。
   首版把作用域钉死在 `projectsRoot`（无项目段），但迁移后的 store 是**逐调用传 `projectId`** 的
   （`readAll(projectId, …)`），两者不一致 → `code-edits` 轨迹被写到 `<projectsRoot>/code-edits/`
   而不是 `<projectsRoot>/<pid>/code-edits/`，`code-channel-m8c` 与 `tool-loop-m8g` 两个用例报 ENOENT。
   根因还有一层：`at()` 与 `abs()` **各算一次根目录**，而 `forProjectsRoot` 用的是 reRoot 后的根、
   `abs()` 用的是原始根。修法：门面的作用域解析改为**按调用参数**解析（`ScopeResolver`），
   并把根目录收敛成单点 `baseDir(projectId)`。
   这是 P1 最重要的教训：**"作用域"必须单点解析，否则写路径与校验路径会分叉**。
4. **一次 PowerShell 管道改写把 `invite-store.ts` 写成了非 UTF-8**（`《` → `?`，U+300A 字节丢失），
   `edit` 工具报 `invalid UTF-8 text` 才暴露。已 `git checkout` 恢复并用 `edit` 重做。
   教训升级：**本仓库的源文件一律只用 `edit`/`write` 工具修改，不用 shell 重定向写入**。

## 复用价值：后续 3 个 store 的迁移样板（P1b 已完成部分）

| store | 迁移方式 |
| --- | --- |
| `code-edit-store.ts` | `mutate` 追加 + `remove` 删除（门面新增 `remove` 能力，避免 application 层出现 `node:fs`） |
| `occupancy-store.ts` | `readJson` / `writeJson` |

由于门面按调用参数解析作用域，store 内部一律写成 `this.store.<method>(projectId, relPath, …)`。

## 遗留（移交 P1b / P3）

### P1b：剩余 10 个 store 迁移（按收益排序）

| 文件 | 现状 IO 数 | 迁移要点 |
| --- | --- | --- |
| `application/artifact/artifact-service.ts` | 18 处 | manifest/版本快照；`mutate` 覆盖 |
| `application/project/project-service.ts` | 12 处 | 项目级 JSON（project.json） |
| `application/session/session-store.ts` | 8 处 | **最复杂**：会话锁、seq 分配、meta 投影、`dir.list` 枚举 |
| `application/roles/role-service.ts` | 7 处 | 用户自建角色目录（非项目作用域，需独立作用域） |
| `application/approval/approval-service.ts` | 5 处 | `mutate` 覆盖整表重写 |
| `application/question/question-service.ts` | 4 处 | 提问表 + 审批待办 |
| `application/code-edit/code-edit-store.ts` | 4 处 | 编辑轨迹 |
| `application/task/task-service.ts` | 4 处 | 任务表（含自建 `KeyedLock`） |
| `application/search/search-service.ts` | 4 处 | 倒排索引（可重建） |
| `application/export/export-service.ts` | 2 处 | zip 导出（需文件系统读，属合理例外） |

### 参数清理（P3）

迁移后部分 store 的 `projectId` 参数已不参与寻址（作用域由注入的门面决定）：
`MemoryStore.append/supersede/listActive`、`FileOwnerStore.*`、`MeetingInviteStore.*`、
`MeetingShedStore.*`、`OccupancyStore.*`。保留位置参数是为了不动所有调用点；
P3 拆分这些文件时一并把这些参数从签名中移除。

### 已知 flaky（既有问题，非本次引入）

`tests/minutes-plan-m8e.test.ts > closed 会议纪要一键转出任务` 在**全量并发**下偶发
`Test timed out in 5000ms`（单独跑稳定 1.9s，连续 3 次全绿）。属既有并发负载问题，
本阶段不改测试超时配置（改测试基础设施需要独立决策）。
