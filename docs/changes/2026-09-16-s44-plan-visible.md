# 修改记录 · S44 会话流显示计划（`plan`）行

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s44-plan-visible.md](../plan/2026-09-16-s44-plan-visible.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-30 / D47

## 1. 需求 / 问题

S43 解释了"两条连续的思考"：**两条之间只隔着一个 `plan` 事件**（计划本身），而按 S22/D28 口径 `plan` **不在会话流显示**。用户随即要求：**"这个也需要显示出来"**（把计划显示出来）。

现状：`VISIBLE_KINDS` 过滤掉 `plan`；`eventBody`/`eventLabel` 也没有 `plan` 分支——直接放开会落到 `JSON.stringify(payload)` 把原始 JSON 铺进会话流。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/lib/event-display.ts` | 新增 `planInfo(event)`（步数/进度/状态/标题清单，容错字符串步骤与缺字段）；`eventBody` 的 `plan` 分支（**仅产出那条**给编号步骤清单）；`eventLabel` 的 `plan` 分支（`计划（N 步）` / `计划进度 · 第 k/N 步` / `计划完成 · N 步` / `计划已中断 · 第 k/N 步`） |
| web | `web/src/pages/SessionPanel.tsx` | `VISIBLE_KINDS` += `plan`；计划行加独立浅紫底色作可见分界 |
| tests | `tests/unit/web/event-display.test.ts` | 新增计划四种形态 + 字符串步骤/缺字段兜底（12 条） |
| docs | `prd`（**D47** + FR-30，并注明修订 D28 的"五类"口径）、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s44` | 全链路回写 |

**未改**：后端与接口（`plan` 事件本来就落盘 + 推送）；思考折叠（S41）、思考来源标注（S43）、工具行口径（S26/S28/S34）、输入框上方提示（S42）；`turn_start`/`turn_end`/`state`/`summary`/`artifact`/`approval_*` **仍不在会话流显示**（详细日志 trace 里可见）。

## 3. 关键决定

1. **只加回 `plan`**：它是计划的可见载体、也是各步之间的界标；不把整批过程事件一起请回来（S22 明确要求去掉过程包装）。
2. **可读渲染，不铺原始 JSON**：产出那条给编号步骤清单（`1. 读代码`），进度/完成/中断只给一行标题——**清单只出现一次**，不随进度重复。
3. **独立底色**：计划行浅紫（`#f9f0ff` / `#efdbff`），与思考/工具行区分，一眼看出"这里分步了"。
4. **容错**：`steps` 支持 `{step,title}` 与字符串；缺 `steps`/`stepIndex` 退化为 `计划（1 步）`。
5. **折叠口径不变**：思考正文仍默认折叠（S41）；计划正文是短清单，直接展示（省一次点击）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web） |
| 单测 | `event-display.test.ts` **12 passed**（新增）：产出 → `计划（2 步）` + `1. 读代码\n2. 写方案`（`inline`）/ 进度 → `计划进度 · 第 1/2 步`（`bodyMode:'none'`）/ 完成 → `计划完成 · 2 步` / 中断 → `计划已中断 · 第 2/2 步` / 字符串步骤 → 编号清单 / 缺 `steps` → `计划（1 步）` |
| 全量测试 | `npm test` **59 files / 378 tests 全绿**（S43 基线 59 / 377） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **142/142**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-CKWIS7rv.js`（1,377.27 kB / gzip 431.17 kB） |
| **未覆盖** | 无浏览器自动化：**须用户点验** —— 多步任务里应看到「计划（N 步）+ 步骤清单」及后续「计划进度 · 第 k/N 步」「计划完成 · N 步」，且两次思考之间因此有了可见分界 |
| 说明 | 与 S15~S43 的交付口径一致 |

## 5. 遗留

- **只放开了 `plan`**：`turn_start`/`turn_end`/`state`/`summary`/`artifact`/`approval_*` 仍只在详细日志（trace）视图可见；若也想在会话流看回合边界，需再明确一轮口径。
- **进度行仍可能偏多**：一次 N 步计划会产生 1（产出）+ N（进度）+ 可能 1（完成）行；当前靠"无正文"控制高度，没有做"合并为一行并原地更新"。
- **步骤 `detail` 不显示**：`plan` 事件的 `steps` 只带 `title`（生产者如此），`detail` 只在生成计划的请求里出现，未落事件。
- **与"两条连续的思考"的关系**：S43 标了思考来源（`思考 · 制定计划`/`思考 · 执行第 N 步`），S44 再补上中间那条界标——两者叠加后，多步执行的过程在会话流里是清楚可读的。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33/S34/S35/S36/S37/S38/S39/S40/S41/S42/S43 记录）。
