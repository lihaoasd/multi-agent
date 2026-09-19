# S44 方案：会话流显示计划（`plan`）行

> 日期：2026-09-16　类型：用户口径（"这个也需要显示出来"，承接 S43/D46 的解释）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s44-plan-visible.md`、`docs/plan/development.md`

## 1 需求

S43 解释了"两条连续的思考"：两条之间只隔着一个 **`plan`** 事件（计划本身），而按 S22/D28 口径 `plan` **不在会话流显示**。用户随即要求：**这个（计划）也需要显示出来。**

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 会话流里能看到**计划** | 出现 `计划（N 步）` 行，正文是编号步骤清单（`1. 读代码` / `2. 写方案`） |
| R2 | 进度可读 | 后续进度行 `计划进度 · 第 k/N 步`；收尾 `计划完成 · N 步`；中断 `计划已中断 · 第 k/N 步` |
| R3 | 一望即知是"分界" | 计划行用**独立底色**，与对话/思考/工具行区分 |
| R4 | 不重复刷屏 | 步骤清单只在产出那条出现一次；进度行只有标题、无正文 |
| R5 | 其它过程事件仍不显示 | `turn_start`/`turn_end`/`state`/`summary`/`artifact`/`approval_*` 仍在详细日志（trace）里看 |
| R6 | 不改后端 | `plan` 事件本来就落盘并推送（`GET /sessions/:sid`、WS `event.appended` 都带） |

## 2 现状与根因

| 位置 | 现状 |
| --- | --- |
| `web/src/pages/SessionPanel.tsx` `VISIBLE_KINDS` | `['message','thought','tool_call','tool_result','error']`——**`plan` 被过滤掉**（S22/D28 口径：去掉过程包装） |
| `web/src/lib/event-display.ts` | `eventBody`/`eventLabel` 对 `plan` 没有分支 → 若直接放出来会落到 `JSON.stringify(payload)`，把原始 JSON 铺在会话流里 |
| 观感 | 于是"制定计划"与"执行第 1 步"两次调用的思考看起来连着（S43 已用 `purpose` 标注缓解，但缺一条可见的界标） |

## 3 关键决定

1. **只把 `plan` 加回来**（修订 S22/D28 的"五类"口径）：它是**计划的可见载体**，也是各步之间的界标；`turn_start`/`turn_end`/`state`/`summary`/`artifact`/`approval_*` 仍不显示——避免把当初明确要删的"过程包装"整体请回来。
2. **可读渲染而非原始 JSON**：
   | 事件 | 标题 | 正文 |
   | --- | --- | --- |
   | 产出（`stepIndex=0 & running`） | `计划（N 步）` | `1. 读代码`\n`2. 写方案`（inline） |
   | 进度（`stepIndex>0 & running`） | `计划进度 · 第 k/N 步` | —（不重复清单） |
   | 完成（`done`） | `计划完成 · N 步` | — |
   | 中断（`interrupted`） | `计划已中断 · 第 k/N 步` | — |
3. **步骤形参容错**：`steps` 既可是 `{step,title}`，也可是字符串；缺 `steps`/缺 `stepIndex` 的旧数据不崩（退回 1 步）。
4. **与思考折叠的关系**：思考正文默认折叠（S41/D44），**计划正文直接展示**——一行一条、信息密度高，正是"计划是什么"的核心。
5. **纯函数先行**：渲染规则落在 `eventBody`/`eventLabel`（node 侧可单测），组件只做映射。

## 4 实现步骤

- `web/src/lib/event-display.ts`：新增 `planInfo(event)`（步数/进度/状态/标题清单）；`eventBody` 的 `plan` 分支（仅产出那条给编号清单）；`eventLabel` 的 `plan` 分支（产出/进度/完成/中断四种文案）。
- `web/src/pages/SessionPanel.tsx`：`VISIBLE_KINDS` += `plan`；计划行加独立底色（浅紫）作视觉分界。
- 测试：`tests/unit/web/event-display.test.ts` 新增计划四种形态 + 字符串步骤/缺字段兜底。
- 文档回写：`prd` **D47** + FR-30 补注、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s44`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `event-display.test.ts` 12 条：计划产出（`计划（2 步）` + `1. 读代码\n2. 写方案`，inline）/ 进度（`计划进度 · 第 1/2 步`，无正文）/ 完成（`计划完成 · 2 步`）/ 中断（`计划已中断 · 第 2/2 步`）/ 字符串步骤 / 缺 `steps`（`计划（1 步）`） |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | 让 Agent 跑一个多步任务：会话流里应出现「计划（N 步）+ 步骤清单」，随后是「计划进度 · 第 k/N 步」「计划完成 · N 步」，且它的出现让两次思考之间有了可见分界 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 会话流变"过程化"（与 S22 诉求相反） | **只放 `plan`**，其余过程事件仍不显示；计划行只一行、进度行无正文 |
| 步骤多时刷屏 | 步骤清单只在产出那条；进度行只给 `k/N`；步数本身受 `maxIterations` 限制（默认 ≤6） |
| 旧日志/字段缺失 | `planInfo` 容错（字符串步骤、缺 `steps`/`stepIndex` 均可用） |
| 与"折叠"口径冲突 | 折叠只针对长文本（思考）；计划正文是短清单，直接展示更省一次点击 |
