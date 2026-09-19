# S43 方案：思考行标出来源步骤（解释"两条连续的思考"）

> 日期：2026-09-16　类型：用户提问（"为什么会有两个连续的思考"）　真源：`design/ui.md` §4、`design/data-storage.md` §4.2、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s43-thought-purpose.md`、`docs/plan/development.md`

## 1 需求 / 问题

用户提问：**为什么会有两个连续的思考？**

先用本机真实日志回答（`data/projects/p_mu7rs071omcf1/sessions/u_architect_1.log.jsonl`）：**每一对"相邻的思考"之间只隔着一个 `plan` 事件**——

| 对 | 之间的事件 | 会话流里可见？ |
| --- | --- | --- |
| `#136 → #138` | `plan` | 否 |
| `#147 → #149` | `plan` | 否 |
| `#154 → #156` | `plan` | 否 |
| `#167 → #169`、`#179 → #181`、`#187 → #189`、`#205 → #207`、`#242 → #244`、`#262 → #264` | `plan` | 否 |

而按 S22/D28 口径，会话流**只显示** 对话 / 思考 / 工具调用（含结果）/ 错误——`plan` 不显示。于是：

- `#136`＝**制定计划**那次模型调用的思考；
- （中间落了一个 `plan` 事件：计划本身）
- `#138`＝**执行第 1 步**那次模型调用的思考。

**两条思考是两次不同的模型调用，不是重复**；只是中间那个"分界"事件恰好不显示，加上思考行**不带来源**，所以看起来像"连着两条、看不出差别的思考"。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 思考行要能看出**来自哪一步** | 标题为 `思考 · 制定计划` / `思考 · 执行第 1 步` / `思考 · 汇总工具结果` / `思考 · 自查（第 1 轮）` … |
| R2 | 历史日志与旧事件不受影响 | 没有 `purpose` 的思考仍是「思考」 |
| R3 | 详细日志（trace）同源 | 摘要前缀来源（`制定计划：…`） |
| R4 | 顺手收掉真正"贴在一起"的重复 | `reflective` 的自查轮原本落两条紧挨着的思考（自查意见 + 该次调用推理）→ 并为一条 |
| R5 | 不改变"哪些事件在会话流显示" | 不把 `plan` 放进会话流（S22/D28 口径不变）；`thought` 仍是同一个 kind，只加可选字段 |

## 2 现状与根因

| 位置 | 现状 |
| --- | --- |
| `strategies.ts` `emitThought(env, text)` | 只落 `{text}`——**不记录这次思考是"制定计划"还是"执行第 N 步"**（而 `callModel` 的 `purpose` 本来就有） |
| `web/src/lib/event-display.ts` `eventLabel` | 思考一律显示「思考」 |
| `reflective` 策略 | S40 给"自查"同时落了「自查意见」与「该次调用的推理」两条思考，**中间没有任何事件**——这是唯一真正"零间隔"的一对 |

## 3 关键决定

1. **标来源，不动可见性**：`purpose` 是解释"为什么两条"的最小信息；把 `plan` 塞回会话流会违背 S22/D28 的既定口径（用户当时明确要求去掉这类过程包装）。
2. **payload 加可选字段**：`thought.payload = {text, purpose?}`——旧日志没有该字段照样渲染（R2）。
3. **`purpose` 直接取模型调用目的**（`制定计划`/`执行第 N 步`/`第 N 步结论`/`直接回答`/`汇总工具结果`/`生成初稿`/`自查（第 N 轮）`/`修订（第 N 轮）`），工具循环后续轮自动带"（工具后续第 k 轮）"——不新造一套命名。
4. **真正贴在一起的两条要合**：`reflective` 自查轮把「意见 + 推理」并入一条（`思考 · 自查（第 1 轮）`）；plan-execute 的"两步之间"是**两次不同调用**，保留两条（标来源后不再歧义）。
5. **纯函数先行**：标题规则落在 `eventLabel`/`traceLine`（node 侧可单测）。

## 4 实现步骤

- `src/application/agent-loop/strategies.ts`：`emitThought(env, text, purpose?)` 落 `{text, purpose}`；`runToolLoop` 传 `request.purpose`；`direct`/`plan-execute`（制定计划、每步）/`reflective`（初稿、修订）各传对应 purpose；`reflective` 自查轮的推理并入同一条思考。
- `web/src/lib/event-display.ts`：`eventLabel` 的 thought 分支 → `思考 · <purpose>`（空/缺省退回「思考」）；`traceLine` 的 thought 分支 → `<purpose>：<text>`。
- 测试：`tests/unit/application/loop-strategies.test.ts`（逐条断言 purpose；reflective 并为一条）、`tests/unit/web/event-display.test.ts`（有/无 purpose、空白 purpose、trace 前缀）。
- 文档回写：`prd` **D46** + FR-30 补注、`ui.md` §4、`data-storage.md` §4.2、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s43`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 实证 | 扫本机 `data/`：所有相邻思考对之间只有 `plan`（见 §1 表）；`plan` 按 S22/D28 不在会话流显示 |
| 单测 | 策略：`thought.purpose` 序列（plan-execute = `制定计划`/`执行第 1 步`/`执行第 2 步`；reflective 并成一条 `自查（第 1 轮）`）；前端：`思考 · 制定计划`、空 purpose 退回「思考」、trace 前缀 |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | 让 Agent 干件事：会话流里两条相邻思考应分别显示 `思考 · 制定计划` 与 `思考 · 执行第 1 步`（不再是无差别的两条「思考」） |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 标题变长 | 只在有 `purpose` 时加后缀；`reflective` 的自查轮并成一条，整体条数不增反减 |
| 旧日志缺字段 | `purpose` 可选，缺省退回「思考」 |
| 用户其实想看"计划本身" | `plan` 仍在详细日志（trace）与拓扑节点/运行细条可见；会话流口径不变（S22/D28） |
| 与 S41 的折叠冲突 | 折叠的是**正文**，标题本来就要显示——加来源反而让折叠态更可读 |
