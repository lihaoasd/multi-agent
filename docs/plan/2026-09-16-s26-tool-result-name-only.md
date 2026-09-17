# S26 方案：工具结果条目只显示工具名

> 日期：2026-09-16　类型：UI 规则调整（用户直接指令）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s26-tool-result-name-only.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"工具结果条目，不要显示其他东西，只要显示工具调用名称"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 会话流里的**工具结果条目只显示工具调用名称** | 该行只有工具名（如 `fs_read_file`），**不显示**结果正文、`#seq · turn N`、也不显示"工具结果"字样 |
| R2 | 失败仍然看得出来 | 结果行失败时整行标红、工具名加粗（**不加任何文字**），否则用户无法察觉工具报错 |
| R3 | 其它条目不变 | 思考（标题+正文+序号）、工具调用（`工具调用 <name>` + 参数）、错误（标题+正文+序号）保持 S22/S24 的形态 |
| R4 | **Agent 自查视图不变** | 后端 `session_recent`（给 Agent 判断用）**仍然带结果文本**——那是 Agent 的判据，不是用户界面 |

## 2 现状与影响面

| 面 | 位置 | 现状（S24 之后） |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` | 工具结果行 = 标题 `工具结果（失败） <name> · #seq · turn N` + 正文（结果全文） |
| 前端 | `web/src/lib/event-display.ts` | `eventLabel`/`eventBody`/`isToolFailed`；**没有"整行怎么渲染"的统一规则**（标签、正文、序号三件事散在组件里） |
| 后端 | `src/infra/tools/builtin/memory.ts`（`session_recent`） | 结果行 `工具结果（成功 fs_read_file）：<结果文本>` —— **Agent 侧，保持不动** |

## 3 关键决定

1. **把"一行怎么渲染"提成纯函数 `eventRow(event)`**：返回 `{ label, body, showMeta }`。这样"工具结果只显示工具名"这条规则能被**单测钉住**（S23/S24 之后前端展示逻辑已经可以被 node 侧 vitest 覆盖），而不是散落在 JSX 里靠点验。
2. **字面执行"不要显示其他东西"**：结果行的 `body = null`、`showMeta = false`、标题就是工具名本身（连"工具结果"四个字都不加）。
3. **失败用颜色而非文字**：`isToolFailed` 仍驱动整行红底红边 + 工具名加粗——这满足"不要显示其他东西"，同时不牺牲"看得见失败"。
4. **只改用户界面**：`session_recent` 是 Agent 自查用的文本视图，结果正文是它的核心判据，**不动**（若一起清掉，Agent 就没法判断工具到底成功与否）。
5. **保留工具调用行的参数**：用户只点了"工具结果条目"，调用行（`工具调用 <name>` + 格式化参数）保持原样。

## 4 实现步骤

- `web/src/lib/event-display.ts`：`eventLabel` 的 `tool_result` 分支改为返回 `toolNameOf(event)`；新增 `EventRow` 类型与 `eventRow(event)`（工具结果 → `body: null`、`showMeta: false`）。
- `web/src/pages/SessionPanel.tsx`：行渲染改用 `eventRow(event)`；`showMeta` 为假时只渲染标题（失败时加粗），`body` 为 `null` 时不渲染正文。
- `tests/unit/web/event-display.test.ts`：新增 `eventRow` 用例（工具结果 → `{ label: 'fs_read_file', body: null, showMeta: false }`；思考/工具调用/错误 → 标题+正文+序号），并更新原来断言"结果行标题带『工具结果』字样"的用例。
- 文档回写：`ui.md` §4、`prd` FR-30 补注 + **D31**、`README.md`/`plan/development.md`/`testing/plan.md` + 验收阶段清单加 `s26`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/web/`（markdown 11 + event-display 8） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| 产物冒烟 | 产物不再含 `工具结果（` 文案（该分支已无此字样），仍含 `工具调用` |
| **交互验证（用户）** | 刷新后确认：工具结果行只有工具名；工具报错时该行变红；工具调用行仍有参数 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 结果正文被藏起来后"工具干了什么"看不到 | 这是用户明确要的取舍；正文仍可在**会话日志/`session_recent`**（Agent 侧）与 `GET .../sessions/:sid/log` 接口看到；若以后想"点一下展开"，属新增交互（记入遗留） |
| 失败被当成普通条目略过 | 失败行标红 + 加粗（R2）；`isToolFailed` 仍有用例覆盖 |
| 与 Agent 侧视图不一致引起困惑 | `ui.md` §4 与本文都写明"用户界面只显示名称；Agent 自查视图仍带结果文本" |
