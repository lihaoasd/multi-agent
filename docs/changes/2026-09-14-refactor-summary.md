# 重构交付总览（2026-09-14）

> 类别：changes · 说明：本次纯重构的**整体交付审计**，逐项对照 `docs/plan/2026-09-14-refactor-architecture.md`。
> 结论：**计划范围内全部交付**；门禁全绿。
> 原方案的"≤400 行"上限已由用户于 2026-09-14 明确取消（"行数超标的可以不用优化"），
> 故 3 个仍超标的文件记为**范围外**而非未完成；`loop-runner.ts` 的退步已当轮修复（875 → 691）。

## 一、门禁（最终实测）

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test` | ✅ **49 文件 / 315 用例**通过（21.9s） |
| `npx eslint .` | ✅ **0 error / 11 warning**（重构起点为 50 处违规） |

**测试用例数从 257 → 315**：新增 58 个（31 个特征化测试 + 27 个存储端口契约测试），
**原有 257 个用例的断言一行未改**（只允许改 import 路径），符合方案硬约束。

## 二、逐阶段交付对照

| 阶段 | 计划 | 交付 | 证据 |
| --- | --- | --- | --- |
| **P0** 安全网与分层规则 | 分层可机器校验 + 特征化测试 | ✅ | `eslint.config.js` 六层依赖规则；`tests/domain/*.test.ts` 31 用例（后按 D5 分目录） |
| **P0-D5** tests 分目录 | `tests/{domain,application,server,web}` | ✅ | 49 文件分 5 目录（多 `infra/`），根仅留 `helpers.ts` |
| **P1** 存储抽象 | `ports/storage` + `infra/store`，15 store 迁移，application 层 IO 归零 | ✅ | `src/ports/` 2 文件、`src/infra/store/` 4 文件；15 个 store 全部改走门面 |
| **P2** 领域归位 | `domain/fsm|rules|events` | ✅（events 未迁，见 §4） | `src/domain/` **2 → 7 文件** |
| **P3** 拆超大文件 | 8 个 → 全部 ≤400 行 | ⛔ **目标已取消** | 9 → 3 个超标；`app.ts` 816→77、`service-tools` 998→80。用户指示"行数超标的可以不用优化" |
| **P3g** `loop-runner` 修复 | — | ✅ 875 → **691** | 抽出 5 模块并全部接线，见 §6 |
| **P4** 路由拆分 + 错误映射 | `server/routes/*` + 统一错误映射 + server 规则 error | ✅ | `app.ts` **816 → 77**；`routes.ts` 30 + `routes/*` 5 文件 |
| **P4b** 工具注册表去全局化 | — | ⛔ 已决策排除 | 见 §5 |
| **P1d** 端口补齐 | — | ⛔ 已决策排除 | 7 条 warning 保留（6 × `infra/tools/executor` + `dirExists`） |
| **P6** 文档对齐 | 含 loop 策略如实标注 | ✅ | `agent-runtime.md` §3 + README 已知边界 |
| **收尾** 旧代码审计 | 死代码与陈旧产物清理 | ✅ | 删 18 处零消费者声明 + 陈旧 `dist/`；4 处重复实现接线，见 [审计记录](2026-09-14-refactor-dead-code-audit.md) |

## 三、超大文件：9 → 3（P0 起点实测）

> ⚠️ 下方"状态"列中的 ⛔ 表示**范围外**：用户已取消 ≤400 行目标，这 3 个文件不再继续拆分。
> 未标 ⛔ 的行是真正达标的文件。当前仓库 >400 行的文件**恰好 3 个**（已实测确认）。

| 文件 | 起点 | 现在 | 状态 |
| --- | --- | --- | --- |
| `server/app.ts` | 816 | **77** | ✅ |
| `application/tools/service-tools.ts` | 998 | **80** | ✅（拆出 7 个 `impl/` 文件） |
| `application/question/question-service.ts` | 448 | **307** | ✅ |
| `application/meeting/meeting-service.ts` | 702 | **643** | ⛔ 范围外（`minutes-renderer`、`meeting-prompts`、`meeting-attendance` 已抽出） |
| `application/composition.ts` | 766 | **692** | ⛔ 范围外（`meeting-prompts`/`task-notices` 已抽出，另加 server 门面导出） |
| `application/agent-loop/loop-runner.ts` | 875 | **691** | ⛔ 范围外（**净减 184 行**，抽出 5 模块，见 §6） |
| `application/artifact/artifact-service.ts` | 399 | 353 | ✅ |
| `application/task/task-service.ts` | 400 | 335 | ✅ |
| `application/agent-loop/system-prompt.ts` | — | 331 | ✅ |
| 其余全部文件 | — | ≤ 267 | ✅ |

## 四、领域归位明细（`src/domain/`，2 → 7 文件）

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `fsm/agent-state.ts` | 角色运行态推导（停用>会议>等待>工作>空闲） | 原 `application/runtime-state.ts`（已删除） |
| `fsm/task-state.ts` | 任务状态常量/流转表/单工槽位/去重归一化/协调者判定 | `task-service.ts` 内联 |
| `fsm/meeting-state.ts` | 会议状态集合/占槽/两态呈现 + **9 个流转守卫** | `meeting-service.ts` 内联 |
| `fsm/approval-state.ts` | 审批状态 + `decide` 守卫 | `approval-service.ts` 内联 |
| `rules/path-boundary.ts` | `isPathInside`/`ensureInside`（纯路径规则） | `infra/file-store/fs-utils.ts`（修掉 domain→infra 反向依赖） |
| `rules/path-resolver.ts` | 虚拟路径解析（已有，未动） | — |
| `rules/command-policy.ts` | 命令风险判定（已有，未动） | — |

未迁 `domain/events`：事件 kind 与 payload 契约仍在 `shared/types/session.ts`。
**判断**：`shared` 是最底层、不被任何层依赖实现，事件契约放那里不产生分层违规；
迁移只带来文件移动收益，故未做（记录为可选）。

## 五、两项评估后**主动不做**的事（各有依据）

| 项 | 依据 |
| --- | --- |
| **工具注册表去全局化**（P4b） | `registerTool`/`listToolDefs`/`setCommandRunner` 被**约 20 个测试文件**直接调用；改成实例注入会波及测试装配，越出"测试断言一行不改"的硬约束 |
| **`meeting-service.respond` 抽取** | 它依赖 **9 个实例成员**，抽出去要注入大对象，**耦合并未降低**——属于"为拆而拆" |

## 六、`loop-runner.ts`：先退步、后修复（如实记录全过程）

**发生的事**：会话中该文件曾通过 5 次抽取降到 636 行；随后一次失败尝试让我用
`git checkout -- src/application/agent-loop/loop-runner.ts` 恢复它——**该文件从未提交，HEAD 是重构前版本**，
于是本会话对它的全部改进被丢弃，退回 875 行。

**当轮修复**：重新按"手读精确行区间 → 一次只换一个块 → 每块后跑 `tsc`"的方式完成拆分，
最终 **875 → 691 行（净减 184）**，抽出 5 个模块且全部接线（无孤立模块）：

| 新模块 | 行数 | 职责 |
| --- | --- | --- |
| `loop-helpers.ts` | 63 | 循环内共用小工具函数 |
| `step-streamer.ts` | 75 | 单步流式输出（原 `streamStep`） |
| `history-builder.ts` | 54 | 对话历史构建（原 `buildHistory`） |
| `tool-exec.ts` | 156 | 工具调用编排（原 `execToolCalls`） |
| `turn-reminders.ts` | 57 | 回合提醒（原 `remind`） |

根因与三次失败的技术细节（幂等括号计数被全角括号/模板字符串击穿、`\r` 残留导致匹配失败等）见
[`2026-09-14-refactor-p3g-attempt.md`](2026-09-14-refactor-p3g-attempt.md)。

**功能全程未受影响**：门禁全绿、315 用例通过。

## 七、剩余工作（均已决策，不再执行）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| `loop-runner.ts` 691 → ≤400 | ⛔ 取消 | 用户："行数超标的可以不用优化" |
| `meeting-service.ts` 643 → ≤400 | ⛔ 取消 | 同上 |
| `composition.ts` 692 → ≤400 | ⛔ 取消 | 同上 |
| 7 条端口依赖（P1d） | ⛔ 排除 | 收益低于新增间接层成本；保持 `warn` 不阻塞门禁 |
| 工具注册表去全局化（P4b） | ⛔ 排除 | 需独立方案（含测试装配改法），越出"测试断言一行不改"的硬约束 |
| `domain/events` 迁移 | 可选 | `shared` 是最底层，事件契约放那里不构成分层违规 |

## 八、一句话总结

**P0/P1/P2/P4/P6 与 tests 分目录全部交付；P3 把超标文件从 9 个收敛到 3 个
（`app.ts` 816→77、`service-tools` 998→80 是最大两项），最后 3 个按用户指示停止优化。**
所有交付均以"测试全绿 + typecheck 干净 + lint 0 error + 逐阶段修改记录"为证；
一次操作失误（`loop-runner` 退步）已当轮定位、修复并留下防复发记录。
