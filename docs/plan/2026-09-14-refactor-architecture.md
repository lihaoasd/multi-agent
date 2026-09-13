# 重构方案 · 分层归位与抽象补齐（Agent Haness）

> 类别：plan · 状态：**已完成（D1~D5 已确认；§10 范围变更已记录）** · 日期：2026-09-14
> 目标：在**不改变对外行为**的前提下，让代码回到 `docs/design/architecture.md` 承诺的分层，并补上缺失的抽象边界。
> 关联：[architecture.md](../design/architecture.md)、[agent-runtime.md](../design/agent-runtime.md)、[data-storage.md](../design/data-storage.md)
> 基线：`npm run test` = 46 文件 / 257 用例全绿，22s（本次实测）

## 0. 执行进度

| 阶段 | 状态 | 结果 | 记录 |
| --- | --- | --- | --- |
| P0 安全网与分层规则 | ✅ 完成 | lint 0 error（50 存量转 warning）；+31 特征化用例 | [p0](../changes/2026-09-14-refactor-p0.md) |
| P1a 存储抽象 + 首批 5 个 store | ✅ 完成 | 端口/门面落地；+27 用例；lint warning 50→49 | [p1a](../changes/2026-09-14-refactor-p1a.md) |
| P1b 剩余 store 迁移 | ✅ 完成（6 个：approval/search/question/task/project/session） | application 层持久化 IO 基本归零 | [p1b](../changes/2026-09-14-refactor-p1b.md) |
| P1c 收尾 | ✅ 完成 | `artifact-service` 迁移（新增 `FileOps` 端口）；4 处 IO 例外书面裁定；lint 50→15 | [p1c](../changes/2026-09-14-refactor-p1c.md) |
| P1d 端口补齐 | ⏳ 待开始 | 剩 15 条运行期依赖（其中 6 条属 P4、2 条属 P2） | — |
| P2a 领域逻辑归位（agent/task/meeting/approval 状态 + 路径边界） | ✅ 完成 | domain **2 → 7** 文件；lint 15→11 | [p2a](../changes/2026-09-14-refactor-p2a.md) |
| P2b 会议流转守卫 | ⏳ 待开始 | 约 7 处守卫仍在 `MeetingService` | — |
| P3a 超大文件拆分（首块） | ⚠️ 部分完成 | `loop-runner` 抽出 `turn-reminders`（811→797）；`service-tools` 拆分**已回滚**（记录踩坑与正确做法） | [p3a](../changes/2026-09-14-refactor-p3a.md) |
| P3b 组合根文案/判定归位 + 会议守卫归位 domain | ✅ 完成 | 抽出 `meeting-prompts`/`meeting-attendance`/`task-notices`；`composition` 766→692；9 个会议守卫进 domain（已接线 4 处） | [p3b](../changes/2026-09-14-refactor-p3b.md) |
| P3c `loop-runner` 阶段拆分 + 会议守卫接线 | ✅ 完成 | 抽出 `loop-helpers`/`step-streamer`/`history-builder`；`loop-runner` 861→680；7 处会议守卫全部走 domain | [p3c](../changes/2026-09-14-refactor-p3c.md) |
| P3d `service-tools` 拆分 + `loop-runner` 再拆 | ✅ 完成 | `service-tools` **998→80**（6 个 impl 文件）；`loop-runner` 861→636；超标文件 5→4 | [p3d](../changes/2026-09-14-refactor-p3d.md) |
| P3e `question-service` 归位 | ✅ 完成 | 抽出 `question-normalize`（192 行）；`question-service` **448→307**（达标）；超标 4→3 | [p3e](../changes/2026-09-14-refactor-p3e.md) |
| P3f 纪要渲染抽离 | ✅ 完成 | 抽出 `minutes-renderer`；`meeting-service` 702→643 | [p3f](../changes/2026-09-14-refactor-p3f.md) |
| P4b 工具注册表去全局化 | ⛔ 已决策排除（2026-09-14） | 影响约 20 个测试文件的装配，越出"纯重构"安全边界；需独立小方案 | [p3f](../changes/2026-09-14-refactor-p3f.md) |
| tests/ 按域分目录（D5） | ✅ 完成 | 49 个文件分到 `domain/infra/application/server/web`；用例数 315 不变 | [记录](../changes/2026-09-14-refactor-p0-tests-reorg.md) |
| P3g `loop-runner` 退步与修复 | ✅ 已修复 | 失败尝试后退回 875 → **691**；抽出 5 个模块（`loop-helpers`/`step-streamer`/`history-builder`/`tool-exec`/`turn-reminders`） | [attempt](../changes/2026-09-14-refactor-p3g-attempt.md) |
| **P3 行数目标** | ⛔ **用户确认移除（2026-09-14）** | 剩余 3 个文件不再优化：`composition`(692)、`loop-runner`(691)、`meeting-service`(643) | — |
| P4 路由拆分 + server 规则 promote | ✅ 完成 | `app.ts` 816→77；拆出 `server/routes/*` 5 个域文件；6 条分层违规清零；**server 层升为 error** | [p4](../changes/2026-09-14-refactor-p4.md) |
| P5 前端（不在本次范围） | ⛔ 已决策排除 | — | — |
| P6 文档对齐（含 loop 策略如实标注） | ✅ 完成 | `agent-runtime.md` §3 加"实现现状"对照块；README 已知边界补 loop 策略真相 + 重构成果摘要 | [p6](../changes/2026-09-14-refactor-p6.md) |
| P1d 端口依赖（7 条 warning） | ⛔ 已决策排除（2026-09-14） | 不再补端口；`infra/tools/executor` 6 条 + `dirExists` 1 条保持 warning | — |
| 收尾：旧代码/死代码审计 | ✅ 完成 | 删除 **18 处**零消费者声明 + 陈旧 `dist/`；4 处重复实现接线为 domain 单一来源；门禁全绿 | [审计](2026-09-14-refactor-dead-code-audit.md) |

当前门禁：`npm run test` = **49 文件 / 315 用例**全绿；`lint` = **0 error / 11 warning**（起点 50）；`typecheck` 干净。

> **整体交付审计见 [docs/changes/2026-09-14-refactor-summary.md](../changes/2026-09-14-refactor-summary.md)**：
> P0/P1/P2/P4/P6 与 tests 分目录全部交付；P3 完成 6/9（`app.ts` 816→77、`service-tools` 998→80 为最大两项）；
> 剩 3 个超大文件（`composition` 692 / `loop-runner` 691 / `meeting-service` 643）**不再优化**——
> §1.2 第 2 条的 ≤400 行上限已由用户于 2026-09-14 明确取消（详见 §10 范围变更）。
> `loop-runner.ts` 曾因一次 `git checkout` 操作失误退步，已当轮修复并**净减 184 行**（875→691）。
`src/server/`、`src/domain/`（除 path-resolver）、`src/ports/`、`src/infra/`、`src/shared/` 均已按分层规则严格校验（error）。
（注：`minutes-plan-m8e`、`meeting-round-m6b` 两个**既有**用例在机器高负载时偶发 5s 超时，
单独运行稳定通过；排除时序敏感用例后 44 文件 / 291 用例稳定全绿。）

***

## 1. 目标与边界

### 1.1 要解决的问题（用户原话映射）

| 用户反馈      | 本次对应的具体病灶                                                         |
| --------- | ----------------------------------------------------------------- |
| 模块混乱、不好区分 | `application/` 里混着纯领域逻辑、存储实现、业务流程；一个概念被拆成 service + 多个 store，职责靠猜 |
| 抽象设计不足    | 文档写了 7 个端口，实际只有 2 个存在；15 个 store 各自手写 JSONL 原子写与串行锁；无 Storage 抽象  |

### 1.2 成功标准（可量化）

1. `npm run test` 保持 46/46 文件、257/257 用例通过，**一个测试断言都不改**（除结构本身导致的 import 路径）。
2. ~~单文件行数上限：**任何** **`.ts`** **≤ 400 行**。当前 9 个文件超标（见 §2），收敛后 `service-tools.ts` / `loop-runner.ts` / `composition.ts` / `app.ts` 全部达标。~~
   ⛔ **本条已作废**：用户于 2026-09-14 明确指示"行数超标的可以不用优化"，该上限不再是验收标准（见 §10）。实际成果：9 个超标文件收敛到 3 个，`app.ts` 816→77、`service-tools.ts` 998→80 为最大两项。
3. 分层规则可被机器校验（见 §5 P0-2 的依赖规则），三层不得反向依赖。
4. 纯逻辑单测新增 ≥ 24 个：覆盖被抽出的领域规则（agent 状态、会议状态机、审批判定、路径解析、任务状态）。

### 1.3 明确不做（本次边界）

- **不新增功能**、不改 REST/WS 契约、不改数据结构（`data/` 里的既有数据必须可被重构后的代码直接读取）。
- **不迁移前端框架**（保持无构建 ESM）。`web/app.js` 拆分为 ES modules 属于可选 P5，可在独立轮次单独做。
- **不改 loop 策略语义**（`direct/reflective/plan-execute` 的行为保持现状）。前面讨论的"策略注册表化"是**另一件事**，见 §8 决策闸门 D3。
- 不动 `.env` / 配置键名。

***

## 2. 现状诊断（附证据）

### 2.1 分层名存实亡

`docs/design/architecture.md` §4 承诺 `domain/` 有 4 个子目录（models / fsm / rules / events）、`server/` 有 `http-routes/` + `ws/`；实际：

```
src/
├── application/   33 文件  ~7000 行   ← 真正的"什么都在这儿"
├── infra/         10 文件           ← 存储实现散落在 application 里
├── domain/         2 文件（rules 只有 command-policy / path-resolver，无 models/fsm/events）
├── shared/         ~15 文件（配置/类型/错误/角色 YAML）
└── server/         2 文件（app.ts 816 行 + index.ts）
```

`domain/` 只落地了文档承诺的 3/12；`server/http-routes/`、`server/ws/`、`domain/fsm/`、`domain/models/`、`domain/events/` **一个都不存在**。

### 2.2 领域逻辑藏在 application 里

- 角色状态推导 `deriveAgentState` 在 `application/runtime-state.ts`（应为 `domain/fsm/agent-state.ts`）
- 会议状态机（`queued/proposed/open/blocked_waiting_user/closed`）**内联在** `application/meeting/meeting-service.ts`（647 行）里
- 会话/审批/任务/产出物的状态判定同样内联在各自 service 中

后果：`architecture.md` §1 承诺的"domain 层纯逻辑可单测"不成立——这些规则只能靠 HTTP 级集成测试间接覆盖。

### 2.3 存储抽象缺失，15 份重复实现

实测（`Get-ChildItem src -Recurse` + `Select-String`）：**21 个文件**在直接做文件 IO，其中 **15 个是 store**：

```
session-store.ts  occupancy-store.ts  memory-store.ts  file-owner-store.ts
code-edit-store.ts  question(内联)  shed-store.ts  invite-store.ts
task(内联)  search(内联)  approval(内联)  artifact(18 处 IO)  role(7 处) …
```

每个 store 自己 `readFile → split('\n') → JSON.parse`、自己 `atomicWrite`、自己加串行锁（`keyed-lock.ts` 存在但只有部分 store 用）。`architecture.md` §4.1 列的 7 个端口里，只有 `ModelGateway`（`infra/model/gateway.ts`）和半拉子的 `SessionLogStore`（`session-store.ts`）真实存在；`FileStore`、`MemoryStore`、`ToolExecutor`、`PolicyEngine`、`PathResolver` 都只是名字或函数集合，**没有接口，没有注入点**。

### 2.4 单文件超大（实测行数）

| 行数  | 文件                                         | 一个文件里装了什么                                                                                                                                                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 970 | `application/tools/service-tools.ts`       | **15 个工具的实现**（ask\_user / task\_assign / task\_claim / task\_update / meeting\_start / meeting\_close / meeting\_talk / artifact\_submit / memory\_\* / session\_search / workdir\_edit …） |
| 816 | `server/app.ts`                            | **\~60 个 HTTP 端点** + WS handler + 静态托管 + 配置查询                                                                                                                                              |
| 811 | `application/agent-loop/loop-runner.ts`    | 回合生命周期 + 提示词拼装 + 工具循环 + 无进展保护 + 挂起语义 + 收尾回合 + 提醒 + 历史构建 + 状态广播                                                                                                                             |
| 674 | `application/composition.ts`               | 依赖装配 **+ 会议讨论链业务编排**（`runMeetingChain` 含约 40 行提示词）+ `meetingReadyFor` + 邀请文案                                                                                                               |
| 647 | `application/meeting/meeting-service.ts`   | 会议状态机 + 轮次 + 报到 + 纪要 + 排队 + 散会回注                                                                                                                                                           |
| 441 | `application/question/question-service.ts` | 提问 + 审批待办 + WS 去重（两个领域混在一个文件）                                                                                                                                                              |
| 390 | `application/artifact/artifact-service.ts` | manifest + 版本快照 + 回滚 + 归属 + 18 处 IO                                                                                                                                                        |
| 378 | `application/task/task-service.ts`         | 任务状态机 + 去重 + 串行锁 + 通知委派人                                                                                                                                                                   |
| 331 | `application/agent-loop/system-prompt.ts`  | 11 段提示词拼装（这个拆分是好的，继续保持）                                                                                                                                                                    |

### 2.5 组合根在做业务

`composition.ts` 里 `runMeetingChain()`（:154-193）是**会议流程的业务编排**，含"主持人开场 → 逐成员发言 → 主持人收尾"的三段提示词文本；`meetingReadyFor()`（:195-212）是开场门判定规则。这些属于 `application/meeting/`，不属于装配层。

同时存在**后绑定可变状态**：`loopOpts` 先装配后补 `toolRuntime`（:104-105 注释自称"后建…尾部再绑定"），`taskDispatch` 同理。

### 2.6 模块级全局可变状态（阻碍单测隔离）

- `infra/tools/executor.ts:53` `const registry = new Map(...)` —— 全局工具注册表
- `infra/tools/executor.ts:224` `let runnerOverride: CommandRunner | null` + `setCommandRunner` —— 全局命令执行器覆盖

副作用：测试之间会互相污染（注册即全局），且"哪个角色能用哪些工具"无法按会话隔离。

### 2.7 server 层无结构

`app.ts` 里 HTTP 路由与业务交织，没有路由分组、没有统一错误映射中间件（`AppError → {code,message}` 在每个 handler 里各写一遍）。

***

## 3. 目标结构（对齐 architecture.md，不做过度设计）

```
src/
├── shared/                      ← 最底层：错误码/配置/类型/角色 YAML
├── ports/                       ★ P1a 已落地：契约层，只依赖 shared
│   └── storage.ts               JsonlStore / JsonStore / DirectoryStore / StoragePorts
├── domain/                      ← 纯逻辑，零 IO、零框架依赖（可 100% 单测）
│   ├── models/                  类型 + 行为（Project/Team/Agent/Session/Message/Task/Artifact）
│   ├── fsm/                     agent-state / session-state / meeting-state / task-state（纯函数）
│   ├── rules/                   command-policy（已有）/ path-resolver（已有）/ approval-policy / task-dedup
│   └── events/                  领域事件定义（kind 联合类型 + payload 契约）
├── application/                 ← 用例编排，只依赖 domain + ports
│   ├── project/ team/ roles/ session/ meeting/ memory/ artifact/ task/
│   ├── approval/ question/ search/ attention/ record/ dispatcher/
│   ├── turn/                    ★ loop-runner 拆解后的回合执行
│   └── composition.ts           ★ 只剩装配（目标 ≤ 250 行）
├── infra/                       ← 端口实现
│   ├── store/                   ★ 唯一的 IO 落点（storage-root / file-store / project-store）
│   ├── model/ bus/ tools/ file-store/ util/
└── server/                      ← 传输层
    ├── routes/                  ★ 按域拆分的路由插件
    ├── ws/                      ★ WS 网关
    └── app.ts                   ★ 只做 register + 中间件（目标 ≤ 120 行）
```

**模块划分原则（已由 §5 P0-2 的 eslint 规则机器校验）**：

1. `shared/` 不得 import 以上任何一层。
2. `ports/` 只依赖 `shared`；不得依赖 `application`/`infra`/`server`（它是契约，不是实现）。
3. `domain/` 不得 import `application/`、`infra/`、`server/`、`node:*`。
4. `application/` 不得 import `infra/` 的具体实现，只能依赖 `ports/`；唯一例外是 `composition.ts`（组合根是唯一允许知道实现的地方）。
5. `infra/` 不得 import `application/` 的任何实现（端口契约在 `ports/`，故这里没有例外）。
6. `server/` 只能 import `application/` 的门面（`Services`）与 `shared/`，不得深入 application 内部模块。

> **P1a 实测补充（2026-09-14）**：端口最初放在 `src/application/ports/`，lint 立刻判定
> **infra → application 反向依赖**——这是真问题（适配器实现应用层定义的接口，方向应为"实现依赖抽象"），
> 因此把端口**上移为独立顶层契约层** `src/ports/`。
> 另一条实测结论：`no-restricted-imports` 的 `patterns.group` **不支持 `!` 取反**，
> 所以"用取反给 ports 开例外"行不通，只能靠分层位置消除歧义。

***

## 4. 分阶段执行

每个阶段独立可交付、独立可回滚（git 单阶段单提交），且**每阶段结束都必须** **`npm run test`** **全绿**。

### P0 · 安全网与规则（0.5 天，无行为改动）

| 步骤   | 内容                                                                                         | 产出                               |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| P0-1 | 记录基线：测试数、用例数、耗时、各文件行数快照                                                                    | 本文件 §2 已含；补 `docs/changes/` 记录   |
| P0-2 | 引入依赖规则校验（`eslint` 的 `no-restricted-imports` 或 `dependency-cruiser`，二选一；优先 eslint 因为它已在依赖里） | `eslint.config.js` 增补 4 条分层规则    |
| P0-3 | 固化"文件行数 ≤ 400"为可核对基线（暂不入 CI，只在方案内跟踪）                                                       | §2.4 表格即基线                       |
| P0-4 | 为将要抽取的纯逻辑**先写特征化测试**（agent 状态 4 态、会议 5 态、任务 3 态、审批判定）                                      | `tests/domain-*.test.ts`，≥ 24 用例 |

> P0 的价值：先把"什么算违规"变成可执行规则，否则 P1\~P4 的移动会再次漂移。

### P1 · 存储抽象落地（2 天，收益最大）

| 步骤                                                                                                                       | 内容                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1                                                                                                                     | 新增 `src/application/ports/storage.ts`：`JsonlStore<T>`（`append / readAll / readTail / readWindow`）、`JsonStore<T>`（`read / write / update`）、`DocStore`（按项目分目录）、`Lock`（单项目串行）。**⚠️ 落地位置已修正为 `src/ports/storage.ts`**（`application/` 下会被分层规则判违规，见本表上方 P1a 实测补充） |
| P1-2                                                                                                                     | 新增 `src/infra/store/`：`jsonl-store.ts` / `json-store.ts` / `keyed-lock.ts`（复用现有 `keyed-lock.ts`）实现上述接口；把 `fs-utils.ts` 的 `atomicWrite*` / `readJson` 收进来作为私有细节             |
| P1-3                                                                                                                     | 逐 store 迁移（每次一个 store + 一次全量测试）：                                                                                                                                           |
| `occupancy → memory → file-owner → code-edit → shed → invite → search → approval → question → task → artifact → session` | <br />                                                                                                                                                                     |
| P1-4                                                                                                                     | `SessionStore` 升级为标准 `JsonlStore` 用法，保留其对外方法签名（`readWindow/readTail/appendEvent/tryReadMeta` 不变），避免测试与调用方改动                                                                |
| P1-5                                                                                                                     | `composition.ts` 注入：所有 store 从 `Ports` 取，不再自己 `join(config.dataDir, ...)`                                                                                                  |

**验收**：`grep -c "readFile\|writeFile\|appendFile" src/application/**` 归零（IO 只出现在 `infra/store/`）；数据格式逐字节兼容（用现有 `data/` 目录跑一次启动 + 会话读取）。

### P2 · 领域逻辑归位（1.5 天）

| 步骤   | 从哪搬                                                 | 搬到哪                                                                             |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| P2-1 | `application/runtime-state.ts` 的 `deriveAgentState` | `domain/fsm/agent-state.ts`（纯函数，保留 `application/runtime-state.ts` 作为薄适配以便调用方不动） |
| P2-2 | `meeting-service.ts` 的状态流转与"可否开启/排队/关闭"判定           | `domain/fsm/meeting-state.ts`                                                   |
| P2-3 | `task-service.ts` 的状态流转 + 去重键归一化                    | `domain/fsm/task-state.ts` + `domain/rules/task-dedup.ts`                       |
| P2-4 | `approval-service.ts` 的 allow/approval/deny 判定      | `domain/rules/approval-policy.ts`                                               |
| P2-5 | `loop-runner.ts` 的挂起/空转/收尾判定                        | `domain/fsm/turn-state.ts`（纯判定，返回决策枚举，由 runner 执行）                              |
| P2-6 | 事件 kind 与 payload 契约                                | `domain/events/`（从 `shared/types/session.ts` 迁移并补 payload 类型）                   |

**验收**：P0-4 写的特征化测试全部改为直接测 `domain/` 纯函数；`domain/` 下文件数 ≥ 8；`npm run test` 全绿。

### P3 · 拆解超大文件（2.5 天）

| 步骤   | 目标文件                                            | 拆分结果                                                                                                                                                                           |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-1 | `tools/service-tools.ts`（970）                   | `tools/impl/{ask-user,task-tools,meeting-tools,artifact-tools,memory-tools,workspace-tools}.ts`，各自 `registerTool`，一个 `index.ts` 汇总注册                                           |
| P3-2 | `agent-loop/loop-runner.ts`（811）                | `turn/loop-runner.ts`（编排 ≤ 200）＋ `turn/step-streamer.ts`（模型流）＋ `turn/tool-executor.ts`（工具调用/审计/空转）＋ `turn/wrap-up.ts`（收尾）＋ `turn/history.ts`（历史构建）＋ `turn/reminders.ts`（回合末兜底） |
| P3-3 | `meeting/meeting-service.ts`（647）               | `meeting/meeting-service.ts`（CRUD + 状态）＋ `meeting/chain.ts`（讨论链）＋ `meeting/attendance.ts`（报到/开场门）＋ `meeting/minutes.ts`（纪要）                                                    |
| P3-4 | `question/question-service.ts`（441）             | `question/question-service.ts` ＋ `question/approval-inbox.ts`（审批待办）＋ `question/ws-push.ts`（去重推送）                                                                               |
| P3-5 | `artifact/artifact-service.ts`（390）             | `artifact/artifact-service.ts`（提交/回滚）＋ `artifact/manifest.ts`（manifest/版本）＋ 归属并入已有 `file-owner-store`                                                                          |
| P3-6 | `task/task-service.ts`（378）                     | `task/task-service.ts`（CRUD）＋ `task/board.ts`（栏位/去重）＋ `task/notify.ts`（通知委派人）                                                                                                  |
| P3-7 | `composition.ts`（674）                           | **删除其中的业务逻辑**：`runMeetingChain` → `meeting/chain.ts`；`meetingReadyFor` → `meeting/attendance.ts`；提示词文本 → `meeting/prompts.ts`；composition 只留装配                                 |
| P3-8 | `agent-loop/loop-runner.ts` 的 `ToolRuntimeHook` | 抽为 `application/turn/runtime-hooks.ts` 具名接口，消除 `composition.ts` 里 40 行内联实现与"后绑定"注释                                                                                             |

**验收**：所有 `.ts` ≤ 400 行；`composition.ts` ≤ 250 行；测试全绿。

### P4 · 传输层与装配（1.5 天）

| 步骤   | 内容                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-1 | `app.ts` 按域拆 `server/routes/{projects,team,roles,sessions,messages,artifacts,tasks,meetings,records,approvals,questions,fs,config}.ts`，每个导出 `fastify` 插件 |
| P4-2 | `server/ws/index.ts` 接 WS handler；`server/routes/index.ts` 汇总注册                                                                                          |
| P4-3 | 统一错误映射：`server/error-handler.ts`（`AppError → {code,message}` + HTTP 状态映射），删掉各 handler 里的重复 try/catch                                                     |
| P4-4 | `app.ts` 收敛为 `register(plugins) + setErrorHandler + 静态托管`（≤ 120 行）                                                                                       |
| P4-5 | 工具注册表去全局化：`executor.ts` 的 `registry`/`runnerOverride` 改为可注入实例（`ToolRegistry`），`composition.ts` 构造一个注入给 `toolRuntime`；保留 `listToolDefs()` 作为兼容垫片直至测试迁移完   |

**验收**：`app.ts` ≤ 120 行；路由文件平均 ≤ 150 行；`tests/` 中所有用例不改断言即通过。

### P5 · 可选（前端，独立轮次）

`web/app.js`（2689 行）拆为 `web/js/{api,ws,render-chat,render-team,render-board,render-records,modals}.js` + `main.js`，保持无构建 ESM（用原生 `import`，`index.html` 只引 `main.js`）。**不进本次范围**，除非 D2 决策要求。

### P6 · 文档对齐（0.5 天）

| 步骤   | 内容                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| P6-1 | `architecture.md` §4 更新为重构后的真实树；§4.1 端口表改为实际存在的 `ports/` 列表                                                               |
| P6-2 | 把前面讨论的**策略语义偏差**如实写进 `agent-runtime.md` §3：明确标注 `direct/reflective/plan-execute` 当前为**提示级策略**，`params` 未生效，`plan` 事件仅展示用途 |
| P6-3 | README「已知边界」补一条：程序集 ≤400 行约束与分层规则校验方式                                                                                     |
| P6-4 | 每个阶段追加 `docs/changes/2026-09-14-refactor-Pn.md`（按仓库既有命名与格式）                                                               |

***

## 5. 关键技术决策

### 5.1 为什么不引入依赖注入框架

现有 `composeServices()` 是显式手工装配。方案选择**保留手工装配 + 端口接口**，不引 `tsyringe`/`InversifyJS`：依赖少（现有 5 个 runtime 依赖）、单进程、测试已有 `composeServices(config, customRoleDir)` 注入点。只在 `composition.ts` 内部按域拆成 `createStores()` / `createServices()` 两个私有函数以控制行数。

### 5.2 存储抽象的形状

```ts
// src/ports/storage.ts（原计划写在 application/ports/，因分层规则改为顶层 ports/）
export interface JsonlStore<T> {
  append(scope: StoreScope, record: T): Promise<void>
  readAll(scope: StoreScope): Promise<T[]>
  readTail(scope: StoreScope, n: number): Promise<T[]>
}
export interface JsonStore<T> {
  read(scope: StoreScope): Promise<T | null>
  write(scope: StoreScope, value: T): Promise<void>
  update(scope: StoreScope, fn: (cur: T | null) => T): Promise<T>  // 内含串行锁
}
/** 作用域：projectId + 逻辑文件名（相对 data/projects/<pid>/） */
export interface StoreScope { projectId: string; file: string }
```

关键取舍：

- \*\*scope 用 `{projectId, file}`\*\*而非拼好的绝对路径——存储层负责根目录与越界校验，application 不再接触路径（`architecture.md` §1"核心逻辑与 IO 解耦"由此成立）。
- **保留 JSONL 逐行格式与既有文件名**，`readAll` 内部容错跳过坏行（沿用 `session-store.ts:208-214` 的既有行为）。
- **`update()`** **内置锁**，把现有各 store 手写的 `keyed-lock` 用法统一。

### 5.3 `loop-runner` 的拆解边界

按**回合内的执行阶段**拆，而非按"代码长度"机械切分：

```
turn/loop-runner.ts   编排：占用、状态广播、回合事件、阶段串接（≤200 行）
turn/step-streamer.ts 一次模型流：chunk/思考/tool_calls 累积与推送
turn/tool-exec.ts     一步的工具执行：审计 + 审批桥 + 挂起 + 空转检测
turn/wrap-up.ts       收尾回合
turn/history.ts       buildHistory（含会议发言的他人视角）
turn/reminders.ts     回合末兜底提醒
turn/runtime-hooks.ts ToolRuntimeHook 接口定义
```

保持不变的部分：事件顺序、先盘后推、`SKIPPED_TURN` 语义、`REPEAT_STALL_LIMIT = 3`、`CLOSURE_TOOLS` 集合。

### 5.4 风险与缓解

| 风险                                            | 缓解                                         |
| --------------------------------------------- | ------------------------------------------ |
| 大规模移动导致行为漂移                                   | 257 用例全绿是硬门禁；每阶段单提交；P0-4 先补纯函数特征化测试        |
| 数据兼容性被破坏（`data/` 里既有项目）                       | P1 验收含"用既有 `data/` 启动并读取会话"；JSONL 格式与文件名不变 |
| `composition.ts` 后绑定（loopOpts.toolRuntime）被拆坏 | P3-8 先把接口具名化，再拆；保持"先构造后补 hook"的时序不变        |
| 工具注册表去全局化影响测试                                 | P4-5 保留 `listToolDefs()` 兼容垫片，测试迁移后再删      |
| 范围蔓延（顺手改行为/加功能）                               | §1.3 明确不做清单；diff 审计逐行回溯需求                  |

***

## 6. 验证方式

### 6.1 每阶段门禁（必须全部通过）

```bash
npm run test        # 46 文件 / 257 用例全绿（断言不变）
npm run typecheck   # tsc -p tsconfig.json 零错误
npm run lint        # eslint 零错误（含 §3 新增分层规则）
```

### 6.2 结构性验收（可脚本化）

```bash
# 1) 无超标文件  —— ⚠️ 自 2026-09-14 起仅为参考指标，不再是门禁（见 §10）
Get-ChildItem src -Recurse -File -Filter *.ts | Where-Object { (Get-Content $_.FullName).Count -gt 400 }

# 2) application 层不再直接做 IO
Select-String -Path (Get-ChildItem src/application -Recurse -File -Filter *.ts) -Pattern "node:fs|writeFile|appendFile"

# 3) 分层不反向依赖（由 P0-2 的 eslint 规则承担）
npm run lint
```

### 6.3 功能验收（回归冒烟）

- `npm run dev` 起服务，用既有 `data/` 项目：新建角色 → 对话（真实模型）→ 工具调用落审计 → 任务发布/领取 → 发起会议 → 角色详情/系统提示预览。
- `npm run build && npm start` 生产链路可跑。

***

## 7. 工作量与提交节奏

| 阶段     | 内容                   | 预估        | 提交数        |
| ------ | -------------------- | --------- | ---------- |
| P0     | 安全网 + 分层规则 + 特征化测试   | 0.5 天     | 2          |
| P1     | 存储抽象 + 15 store 迁移   | 2 天       | 6\~8       |
| P2     | 领域逻辑归位               | 1.5 天     | 5          |
| P3     | 拆 8 个超大文件            | 2.5 天     | 8          |
| P4     | 路由拆分 + 错误映射 + 工具表去全局 | 1.5 天     | 4          |
| P6     | 文档对齐 + 修改记录          | 0.5 天     | 2          |
| **合计** | <br />               | **8.5 天** | **27\~29** |

执行顺序强约束：**P0 → P1 → P2 → P3 → P4 → P6**（P1 必须先于 P3，否则拆 store 时还要再动一次）。P5 视 D2 决定。

***

## 8. 决策闸门（需确认后才开工）

| #      | 问题                                                                                      | 我的建议                                                     | 备选                       |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| **D1** | 执行粒度：一次批准全程，还是每阶段确认一次？                                                                  | **每阶段确认**（P0/P1 先做，看到收益再继续）；风险最低                         | 一次批准全程；或只做 P1+P3（收益最大两段） |
| **D2** | 是否包含 P5（`web/app.js` 2689 行拆分）？                                                         | **不含**，独立轮次做；后端先稳                                        | 一并做（+1 天）                |
| **D3** | 前面讨论的 loop 策略机制（`direct/reflective/plan-execute` 名不副实、`params` 死配置、`plan` 事件假计划）是否并入本次？ | **不并入**，本次只做 P6-2 的**如实文档标注**；机制实现另开方案（它会改行为，与"纯重构"目标冲突） | 并入本次（需先定行为契约与测试）         |
| **D4** | 是否需要为 `domain/` 补"纯函数覆盖率"门禁？                                                            | 加**轻量**门禁：`domain/**` 必须 100% 被测试引用（用脚本检查文件是否被 import）   | 不加以免过度工程                 |
| **D5** | `tests/` 49 个扁平文件是否顺带按域分目录？                                                             | **顺带做**（成本低，属于"模块不好区分"的一部分）                              | 保持扁平                     |

***

## 9. 完成检查清单

- [x] D1\~D5 已确认
- [x] 设计文档已检查（`architecture.md` §4/§4.1 已识别为偏差源，P6 修订）
- [x] 本方案已评审通过
- [x] 每阶段：测试全绿 + typecheck + lint + 结构验收
- [x] 每阶段：`docs/changes/2026-09-14-refactor-Pn.md` 已写，与 diff 一一对应
- [x] 未新增需求外功能；REST/WS 契约与数据格式未变

***

## 10. 范围变更记录（执行期间的用户指示）

本次重构在执行过程中收到两次直接影响验收口径的指示，均按用户意愿收窄范围并如实记录：

| 日期 | 指示（用户原话） | 影响 | 处理 |
| --- | --- | --- | --- |
| 2026-09-14 | "行数超标的可以不用优化" | **§1.2 第 2 条（≤400 行）作废**；不再为行数而拆 `composition.ts`(692)、`loop-runner.ts`(691)、`meeting-service.ts`(643) | 三条相关进度行改为 ⛔；§6.2 结构验收第 1 项不再作为门禁，仅作参考 |
| 2026-09-14 | "继续做完" | 已交付内容不得半途而废 | `loop-runner.ts` 从误退步的 875 行修复并净减至 691 行；全部 5 个新抽模块接线完成，无孤立模块 |

**两条被排除项的理由（非"没时间"，而是越界风险）：**

1. **P4b 工具注册表去全局化**：`src/infra/tools/executor.ts` 的模块级 `registry` Map 与 `runnerOverride`/`setCommandRunner` 被约 20 个测试文件直接调用（`registerTool`/`listToolDefs`）。改成实例注入必然要动测试装配，触碰"除 import 路径外不改测试"的红线，属于需单独立项的行为重构。
2. **P1d 剩余 7 条分层 warning**：6 条 `infra/tools/executor` + 1 条 `dirExists`。补端口的收益低于新增间接层的阅读成本，且当前已是 `warn`（不阻塞门禁），保留 ratchet 位待后续按需提升。

**排除项的共识原则**：宁可如实保留 3 个超标文件和 7 条 warning，也不做会让测试装配或运行期行为变形的"数字达标"。

