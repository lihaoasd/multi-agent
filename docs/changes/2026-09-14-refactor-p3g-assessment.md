# 修改记录 · 重构 P3g 评估：最后 3 个超标文件的共同阻塞点

> 日期：2026-09-14 · 阶段：P3g（评估，未实施）
> 类型：纯重构前的判断记录

## 结论

P3 只剩 3 个超标文件（P0 起点 9 个）：

| 行数 | 文件 | 最大单块 |
| --- | --- | --- |
| 692 | `application/composition.ts` | `composeServices` 约 550 行（装配序列） |
| 643 | `application/meeting/meeting-service.ts` | `respond` 78 行 / `create` 46 行 |
| 636 | `application/agent-loop/loop-runner.ts` | `runTurnCore` **287 行** |

本轮我逐个评估了"能不能像前面那样按块抽出去"，**结论是都不能靠零散抽取解决**，
原因是它们有**同一个共同阻塞点**：

> **这些块的依赖是"实例私有方法的集合"，而不是可枚举的服务依赖。**

具体证据（都已核对过调用点）：

| 块 | 依赖的实例成员 | 抽出去的代价 |
| --- | --- | --- |
| `loop-runner.runTurnCore` | `streamStep` / `execToolCalls` / `runWrapUp` / `remindUnreportedTask` / `appendThought` / `appendStepMessage` / `appendAudit` / `buildHistory` / `nextTurn` / `opts`（**10 项**） | 要定义一个新的依赖包接口并逐项接线 |
| `meeting-service.respond` | `get` / `append` / `store` / `emitLineup` / `onShed` / `onInvited` / `onOpen` / `onJoined` / `markJoined`（**9 项**） | 同上 |
| `loop-runner.runWrapUp` | `streamStep` / `appendThought` / `execToolCalls` + `opts.toolRuntime`（4 项） | 只减约 30 行，性价比为负 |

前面成功的抽取（`tool-exec` 205 行、`step-streamer`、`history-builder`、`loop-helpers`、
`minutes-renderer`、`question-normalize`、`service-tools` 的 6 个 impl 文件）之所以顺，
是因为它们的依赖**收敛成 3 项以内**或本身是纯函数。

## 因此需要的不是"再抽一块"，而是一次**接口重组**

以 `loop-runner` 为例，正确做法是：

1. 定义 `TurnEngineDeps`（把上述 10 项显式化，其中 `append*` 可合并成一个 `TurnLog` 接口）；
2. 把 `runTurnCore` 整体移入 `turn-core.ts`，runner 只剩"占用/广播/收尾"的外壳（约 60 行）；
3. 同理 `runWrapUp`/`remindUnreportedTask` 可以并入同一个引擎模块。

这会**同时**让 `loop-runner` 从 636 降到约 150 行、`turn-core` 本身也在 400 以内。

`meeting-service` 的对应做法是按**职责**重组：
把"成员回应 + 入会编排 + 报到台账"整体移到 `meeting-attendance.ts`
（把 `emitLineup`/`markJoined` 一并迁走，它们本就是同一职责）。

`composition.ts` 则是把 `composeServices` 里的 `new Xxx(...)` 及其钩子按域切成
`bootstrap/stores.ts` / `bootstrap/session.ts` / `bootstrap/delegation.ts` 等。

## 为什么本轮不做

这三项都属于**中等规模的结构改动**（不是机械搬运）：每项都要新增一个依赖接口、
并逐个接线验证。在本次会话剩余的预算内硬做，风险是**改坏核心回合循环**——
而它的验证成本恰恰最高（`loop-runner` 是全部 315 个用例的公共路径）。

我选择**记录清楚并交回决策**，而不是在收尾阶段赌一把。

## 建议

- 若继续：**优先 `loop-runner`**（收益最大：636 → 约 150），一次一轮、每轮跑全量；
- `meeting-service` 与 `composition` 依次。
- 这三项完成后，P3 的"所有 `.ts` ≤ 400 行"即达成。
