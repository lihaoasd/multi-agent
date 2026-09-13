# 修改记录 · 重构 P3a：超大文件拆分（首次尝试与工程判断）

> 日期：2026-09-14 · 阶段：P3（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构
> 结果：**`service-tools.ts` 拆分未交付**（已回滚，保留 P2 的 import 修正）；本轮净改动很小。

## 目标

P3 要把 6 个超标文件拆到 ≤400 行：

| 行数 | 文件 |
| --- | --- |
| 998 | `application/tools/service-tools.ts` |
| 816 | `server/app.ts` |
| 811 | `application/agent-loop/loop-runner.ts` |
| 733 | `application/composition.ts` |
| 652 | `application/meeting/meeting-service.ts` |
| 422 | `application/question/question-service.ts` |

## 本轮做了什么、以及为什么回滚

### 尝试：按工具块把 `service-tools.ts` 拆到 `tools/impl/`

边界本身很清晰（12 个 `registerTool` 调用、7 个工具组）。我写了脚本按键区间抽取，抽出后
再补模块头（imports / 注册函数 / `if (deps)` 条件包裹），最后把 `service-tools.ts` 变成纯编排。

**结果：抽取阶段反复出错，最终回滚。** 记录踩过的坑（供后续参考，避免重犯）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 块尾判断错位 | 括号朴素计数被**中文全角括号**干扰 |
| 2 | 块尾仍错位 | 模板串 `${rec.items.map((it, i) => …)}` 里的**箭头函数括号** |
| 3 | 仍错位 | 模板里**再嵌模板**且内含单引号：`` `${a ? `${b}) ` : ''}` `` |
| 4 | 生成文件语法错误 | 原块的收尾 `)` 之后**本来就带**包装 `if` 的 `}`，我的生成器又补了一个 |

前 3 条都属于"用解析器 + 正则处理 TS 源码"的典型风险；第 4 条是边界约定没核对清楚。

### 工程判断：回滚，而不是继续磨

到这里我已在**一个机械拆分**上耗掉本轮大部分预算，且每修一处就暴露下一处边界假设错误。
继续下去的风险是：**在低价值、易错的机械工作上耗尽预算，导致 P3/P4 的实质目标（`app.ts`
路由拆分、`loop-runner` 拆解）无法推进**。

因此判定：**回滚 `service-tools.ts` 的拆分**，保留其中真正有价值的 P2 修正，把预算转向收益更高的拆分。

### 回滚后保留的净改动

| 文件 | 改动 |
| --- | --- |
| `application/tools/service-tools.ts` | 仅保留 `ensureInside` 的导入改指 `domain/rules/path-boundary.js`（P2 成果） |
| `eslint.config.js` | `globalIgnores` 增加 `.test-tmp/`（临时目录被 eslint 扫到导致解析错误） |

`tools/impl/` 目录已删除；`service-tools.ts` 恢复为 998 行的单文件（内容等同 HEAD + import 修正）。

## 验证结果（确认回滚没有遗留）

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过，22.2s |
| `npx eslint .` | ✅ 0 error / **11 warning**（与 P2 持平，未回退） |

## 下一轮的正确做法（写下来，不再重复踩坑）

1. **不要写解析器拆 TS 源文件。** 用"复制目标块 → 手工调整 imports"的方式，一次拆一个文件的一个块，
   每次拆完立刻 `tsc` + 跑该文件的测试；宁可拆得慢，也不要一次生成 7 个文件再修。
2. **优先拆 `server/app.ts`（P4 范围）**：它的拆分边界是**路由**（`app.get/post/...` 调用），
   按域分组即可，不需要解析嵌套结构；且拆完能同时解决 6 条"server 深入 application 内部模块"的分层违规。
3. **`loop-runner.ts` 按执行阶段拆**（`step-streamer` / `tool-exec` / `wrap-up` / `history` / `reminders`），
   每个阶段都是独立函数，边界比"按工具块"更规整。
4. `service-tools.ts` 若再拆，建议**按注册顺序切分成少数几个大块**（如"记忆+检索"、"写通道"、"平台交互"），
   而不是 7 个细粒度文件——降低边界数量即降低出错面。

## 状态

`service-tools.ts` 的拆分未交付（已回滚）。目标状态（所有 `.ts` ≤ 400 行）保持为待办。

## 追加交付：`loop-runner` 的首个阶段抽取（P3 首块）

按上面第 3 条建议（按执行阶段拆、每次只拆一块、拆完立即验证）做了第一个块：

| 文件 | 改动 |
| --- | --- |
| `application/agent-loop/turn-reminders.ts` | **新增**：`buildTurnEndReminders()` 纯函数（回合末三类提醒的文案构建，约 45 行） |
| `application/agent-loop/loop-runner.ts` | 该方法体从内联文案拼接改为"取数 → 调纯函数 → 落盘"；**811 → 797 行** |

抽出的三类提醒（各自独立、可同时出现）：
1. 有进行中任务但本回合没 `task_update` → 提醒上报完成；
2. 任务栏还有派给我未领取的任务且没 `task_claim` → 提醒先领取再上报；
3. 本回合只调工具、没有正文 → 提醒补完成总结。

纯函数入参是**最小投影**（`ReminderActiveTask` / `ReminderPendingTask`），不依赖 store/bus，
可单独断言。文案与原实现逐字一致。

验证：`tsc` 干净、`npx eslint .` = 0 error / 11 warning、`npm run test` = 49 文件 / 315 用例通过（22.4s）。

