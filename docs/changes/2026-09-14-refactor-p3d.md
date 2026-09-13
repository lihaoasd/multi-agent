# 修改记录 · 重构 P3d：`service-tools` 拆分成功 + `loop-runner` 再拆两块

> 日期：2026-09-14 · 阶段：P3d（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化）
> 上接：[p3c](2026-09-14-refactor-p3c.md)

## 本轮最大的事：P3a 失败的拆分这次成功了

P3a 里 `service-tools.ts`（998 行）拆分反复失败并回滚。本轮按当时记下的正确做法重做并**成功**：

| 新增 | 行数 | 工具 |
| --- | --- | --- |
| `tools/impl/context.ts` | 50 | 共享依赖面 `ServiceToolDeps`（不 import 实现，只声明形状） |
| `tools/impl/memory-search-tools.ts` | 100 | `memory_append` / `memory_search` / `session_search` |
| `tools/impl/workdir-edit.ts` | 170 | `workdir_edit`（项目目录唯一写通道） |
| `tools/impl/ask-user.ts` | 113 | `ask_user` |
| `tools/impl/artifact-submit.ts` | 150 | `artifact_submit` |
| `tools/impl/task-tools.ts` | 232 | `task_assign` / `task_claim` / `task_update` |
| `tools/impl/platform-tools.ts` | 194 | `meeting_start` / `meeting_close` / `meeting_talk` |

`application/tools/service-tools.ts`：**998 → 80 行**（只剩"组装 `ServiceToolDeps` + 按固定顺序调用 6 个 `register*`"）。
**12 个工具一个不少**，注册顺序与拆分前一致。

### 与 P3a 的做法差异（这次为什么成了）

| P3a（失败） | P3d（成功） |
| --- | --- |
| 试图写通用括号解析器找块边界 | **不做解析**：用逐行核对过的实测区间 |
| 一次生成 7 个细粒度文件 | 切成 **6 个块**（少数大块） |
| 解构放在函数顶部 | **先合并解构，再由各块 `if` 收窄**（与原文 `let` 收窄等价） |
| 区间起点没核对，含了原 `if (...)` 行 | 起点逐个核对，**包装块从块内第一行取** |
| 生成后一次性修 | **每改一处就 `tsc`**，直到只剩下一类错误 |

### 过程中解决的 4 类具体问题（都可复现，值得记录）

1. **包装块的原始 `}` 被重复**：区间已含原 `if` 的收尾 `}`，生成器又补了一个 → 剥掉区间尾部的 `}`。
2. **区间起点含了原 `if (...)` 行** → 生成的文件里出现两个嵌套 `if (questions)`，而第一个引用未声明的变量。
3. **解构放进 `if` 内部** → `if (questions)` 的**条件头**引用了解构出来的 `questions`，作用域错误。
   最终形态：`const { questions } = deps` 在函数体顶部，`if (questions) { ... }` 在其后收窄。
4. **多块重复解构** → `task` 被声明两次；改为**合并所有块需要的键**成一条解构。

## `loop-runner` 再拆两块（861 → 636）

| 新增 | 行数 | 内容 |
| --- | --- | --- |
| `agent-loop/tool-exec.ts` | 205 | `execToolCalls()`：审批阻塞语义、挂起语义、无进展检测 |
| `agent-loop/loop-helpers.ts` | 68 | 上限常量、收尾提示词、`SKIPPED_TURN` + JSON/截断/摘要纯工具 |
| `agent-loop/step-streamer.ts` | 76 | `streamStep()`：单步模型流与实时推送 |
| `agent-loop/history-builder.ts` | 62 | `buildHistory()`：日志窗口 → 对话消息 |

`loop-runner.ts` **861 → 636 行**。`execToolCalls` 通过 `ToolExecDeps` 注入（exec / requestApproval / appendAudit），
不绑定 runner 实例；三件产品语义（审批挂起、ask_user 挂起、连续空转保护）写在模块自己的注释里。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过 |
| `npx eslint .` | ✅ **0 error / 11 warning** |

### 关于 warning 从 6 升到 11（如实说明）

原因是**同一处依赖被按文件计数**：`infra/tools/executor.js` 的 `registerTool` 原先只在
`service-tools.ts` 出现 1 次，拆成 6 个文件后变成 6 次。

同时修了棘轮配置的一个真实疏漏：`src/application/tools/**/*.ts` **只匹配一层**，
`tools/impl/**` 不匹配，因此新文件本该以 error 形式报出"应用层直接依赖 infra 实现"。
已补 `'src/application/tools/impl/**/*.ts'` 到豁免清单（按现状保持 warn），
**收敛这 6 处需要"工具注册表端口"**（属 P1d 范围，与其它 5 处同类）。

## 当前超标文件（5 → 4）

| 行数 | 文件 | 说明 |
| --- | --- | --- |
| 692 | `application/composition.ts` | 余下约 550 行为装配序列；拆它需要切依赖图 |
| 656 | `application/meeting/meeting-service.ts` | 守卫已归位 domain；可拆讨论链/纪要 |
| 636 | `application/agent-loop/loop-runner.ts` | 本轮 861→636；可再拆 `runWrapUp`(~40) 与 `runTurnCore`(~250) |
| 422 | `application/question/question-service.ts` | 略超，最后处理 |

**P3 距离"所有 `.ts` ≤ 400 行"只剩这 4 个文件**（P0 起点是 9 个）。

## 下轮建议

1. `loop-runner` 拆 `runTurnCore`（约 250 行）——它是"回合状态机"本体，拆出来能让 runner 只剩几十行。
2. `question-service`（422）最接近达标，先解决它。
3. `meeting-service` 的讨论链与纪要生成各成一块。
4. `composition.ts` 最后评估（装配体，收益主要是行数）。
