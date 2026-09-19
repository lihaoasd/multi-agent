# 修改记录 · S43 思考行标出来源步骤

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s43-thought-purpose.md](../plan/2026-09-16-s43-thought-purpose.md)
> 关联设计：[ui.md](../design/ui.md) §4、[data-storage.md](../design/data-storage.md) §4.2、[prd](../requirements/prd.md) FR-30 / D46

## 1. 需求 / 问题

用户提问：**"为什么会有两个连续的思考？"**

**先用真实日志回答**（本机 `data/projects/p_mu7rs071omcf1/sessions/u_architect_1.log.jsonl`）：扫描全部 `thought` 事件后发现——**每一对相邻思考之间只隔着一个 `plan` 事件**（`#136→#138`、`#147→#149`、`#154→#156`、`#167→#169`、`#179→#181`、`#187→#189`、`#205→#207`、`#242→#244`、`#262→#264`，无一例外）；而按 S22/D28 口径 **`plan` 不在会话流显示**（会话流只显示 对话/思考/工具调用+结果/错误）。

所以那两条是**两次不同的模型调用**：`#136` 是"制定计划"这次调用的思考，`#138` 是"执行第 1 步"这次调用的思考，中间那个 `plan`（计划本身）被隐藏了。加上思考行**不带来源**，就成了"两条连着、看不出差别"的观感。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| application | `src/application/agent-loop/strategies.ts` | `emitThought(env, text, purpose?)` → payload `{text, purpose}`；`runToolLoop` 传 `request.purpose`；`direct` 传 `直接回答`；`plan-execute` 传 `制定计划` / `执行第 N 步`；`reflective` 传 `生成初稿` / `自查（第 N 轮）` / `修订（第 N 轮）`；**自查轮的推理并入同一条思考**（原先会落两条零间隔的思考） |
| web | `web/src/lib/event-display.ts` | `eventLabel` 的 thought → `思考 · <purpose>`（缺省/空白退回「思考」）；`traceLine` 的 thought → `<purpose>：<text>` |
| tests | `tests/unit/application/loop-strategies.test.ts`、`tests/unit/web/event-display.test.ts` | 见 §4 |
| docs | `prd`（**D46** + FR-30 补注）、`ui.md` §4、`data-storage.md` §4.2、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s43` | 全链路回写 |

**未改**：会话流"显示哪些事件"的口径（**不把 `plan` 放回会话流**，S22/D28 不变）；`thought` 事件 kind 与落盘模型（只加可选字段）；思考的折叠行为（S41）；其它条目渲染（S26/S28/S34/S39）。

## 3. 关键决定

1. **标来源，而不是改变可见性**：`purpose` 是解释"为什么两条"的最小信息；把 `plan` 塞回会话流会违背用户当初明确要求去掉过程包装的口径（S22/D28）。
2. **`purpose` 复用既有语义**：直接取 `callModel` 的目的（本来就传给模型日志/进度），不新造命名；工具循环后续轮自动带"（工具后续第 k 轮）"。
3. **真正零间隔的两条要合**：`reflective` 自查轮的「意见」与「该次调用的推理」原本中间没有任何事件——并入一条 `思考 · 自查（第 N 轮）`；plan-execute 的两步之间是**两次不同调用**，保留两条（标来源后不再歧义）。
4. **可选字段，向后兼容**：旧日志/缺字段仍渲染为「思考」。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 策略单测 | `loop-strategies.test.ts` **11 passed**：plan-execute 的 `thought.purpose` 序列为 `制定计划` / `执行第 1 步` / `执行第 2 步`；`direct` 两轮思考各落一条；`reflective` 自查轮**并为一条**（`自查（第 1 轮）`） |
| 前端单测 | `event-display.test.ts` **11 passed**：`思考 · 制定计划`、`思考 · 执行第 1 步`、无 `purpose`/空白 `purpose` 退回「思考」、详细日志 `制定计划：想一下` |
| 全量测试 | `npm test` **59 files / 377 tests 全绿**（S42 基线 59 / 376） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BAnmAQ6b.js`（1,376.40 kB / gzip 430.89 kB） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— 会话流里两条相邻思考应分别显示 `思考 · 制定计划` 与 `思考 · 执行第 1 步` |
| 说明 | 与 S15~S42 的交付口径一致 |

## 5. 遗留

- **计划的"分界感"仍靠标题**：会话流不显示 `plan`（S22/D28 口径），所以只能从"思考 · 制定计划 / 执行第 1 步"看出分界；若希望会话流里有更明显的步骤分隔线（例如 `— 第 1 步 —` 这样的轻量标记），属新交互，未做。
- **`purpose` 是自由文本**：由策略传入，未做枚举校验；新策略若不传该字段就退回「思考」。
- **思考条数仍随轮次线性增长**：工具循环每轮一条 + plan-execute 每步一条；靠 S41 的折叠收敛，没有"按轮次分组/汇总"。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36/S37/S38/S39/S40/S41/S42 记录）。
