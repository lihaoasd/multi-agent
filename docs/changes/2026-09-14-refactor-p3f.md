# 修改记录 · 重构 P3f：纪要渲染抽离 + 工具注册表去全局化的评估

> 日期：2026-09-14 · 阶段：P3f（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构
> 上接：[p3e](2026-09-14-refactor-p3e.md)

## 本轮改动

| 文件 | 改动 |
| --- | --- |
| `application/meeting/minutes-renderer.ts` | **新增** 45 行：`renderMeetingMinutes()` 纯函数 |
| `application/meeting/meeting-service.ts` | **702 → 643 行**；`renderMinutes` 改为"读窗口 → 调纯函数" |

纪要渲染现状是**规则式（MVP）**：取最近 12 条 `meeting_event` + 主持人/成员 + 用户决策点，
拼成文本，末行显式写 `(规则式纪要 MVP，真实生成 M8)`——保留这句是为了不让人误以为已有模型生成。
抽成纯函数后（输入=会议记录+事件窗口，输出=文本），它可单独断言；文案逐字未改。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npx eslint .` | ✅ 0 error / 11 warning |

（全量测试在下一节一并给出。）

## 关于 P4 剩余项「工具注册表去全局化」：**评估后本轮不做**（记录理由）

`infra/tools/executor.ts` 里有两处进程级可变状态：

| 状态 | 位置 | 影响 |
| --- | --- | --- |
| `const registry = new Map(...)` | :53 | 工具注册是**模块级单例**，测试之间会互相污染 |
| `let runnerOverride` + `setCommandRunner()` | :224 | 命令执行器被全局覆盖，无法按会话隔离 |

计划里 P4 写着"工具注册表去全局化"。我本轮做了成本评估后**决定不做**，理由：

1. **影响面比预想大**：`registerTool` / `listToolDefs` / `isRegistered` / `executeTool` /
   `setCommandRunner` 被 **约 20 个测试文件**直接调用（`task-completion-m8p` 17 处、
   `task-board-m8m` 14 处、`workdir-edit-safety-m8q` 11 处…）。
2. **改成实例注入会波及测试装配**，而本重构的硬约束是"测试断言一行不改（仅允许改 import 路径）"。
   为达成隔离而要求 20 个测试文件各建一个注册表实例，已经越出"纯重构"的安全边界。
3. **它不影响 P4 的主目标**：P4 的核心（路由拆分、错误映射统一、"server 不得深入 application"）
   已交付，`app.ts` 816→77、server 层规则已 promote 为 error。

**因此记为待办**，需要的是一次独立的小方案（含测试装配改法），而不是在本轮硬塞。

## 当前超标文件（3 个，P0 起点 9 个）

| 行数 | 文件 | 拆法（已明确） |
| --- | --- | --- |
| 692 | `application/composition.ts` | 装配体；按域把 `new Xxx(...)` 及其钩子切成 `bootstrap/*.ts` |
| 643 | `application/meeting/meeting-service.ts` | `respond`（~78 行）的回应编排、`markJoined`/`list`/`activeCount` 各自成块 |
| 636 | `application/agent-loop/loop-runner.ts` | `runTurnCore`（~250 行）是回合状态机本体，抽出后 runner 只剩几十行 |

## 下轮建议

1. **`meeting-service`**：按 P3d 的成功配方（实测区间 + 少数大块 + 每块立即验证）拆，
   它是三个里边界最规整的（方法级）。
2. **`loop-runner`**：抽 `runTurnCore`——收益最大（一次减约 250 行），但它是核心循环，
   需要把 `this.opts` 依赖显式化，属三者中最需要小心的。
3. **`composition.ts`**：最后做；它现在同时承担装配、各域工厂与 server 门面导出，
   拆它要把依赖图切片。
