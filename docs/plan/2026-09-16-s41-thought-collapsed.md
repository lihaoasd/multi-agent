# S41 方案：思考条目默认折叠

> 日期：2026-09-16　类型：用户口径（"think要折叠"）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s41-thought-collapsed.md`、`docs/plan/development.md`

## 1 需求

用户口径：**think 要折叠。**

S40 打开思考后，`thought` 每次模型调用落一条（plan-execute 的制定计划 + 每一步、工具循环每一轮），正文是完整思维链——**直接内联会把会话流刷屏**。要求与工具调用参数同一口径：**默认折叠、点击展开**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 思考条目**默认折叠** | 会话流里思考行默认只显示标题 `思考 · #seq · turn N`，点击展开看思维链 |
| R2 | 没有正文时**不出现空面板** | 空白/空正文退化为纯标题行（`bodyMode: 'none'`） |
| R3 | 其它条目口径不变 | 消息/错误仍直接展示；工具调用参数仍折叠；工具结果成功只显示名称、失败显示报错正文（S26/S28/S34） |
| R4 | 只改"一行怎么渲染" | 落在纯函数 `eventRow`（可单测），不新增交互与依赖；事件模型不动 |

## 2 现状与根因

| 位置 | 现状 |
| --- | --- |
| `web/src/lib/event-display.ts` `eventRow` | 只有 `tool_call` 走 `bodyMode: 'collapsed'`，其余（含 `thought`）走 `'inline'` → 思考整段铺在会话流里 |
| `web/src/pages/SessionPanel.tsx` | 折叠渲染路径**已存在**（S28 起 antd `Collapse` ghost，标题=行标题、子节点=正文），无需新增 UI 代码 |

即：这是 S40 的配套收口——**生产端多了思考，展示端要跟着收**。

## 3 关键决定

1. **与工具调用同一口径**：`thought` 复用 `collapsed`，标题只显示 `思考 · #seq · turn N`（与 `工具调用 <名> · #seq · turn N` 对称），不额外造一种折叠样式。
2. **空白正文一律按"没有正文"处理**：新增 `hasBody = body.trim().length > 0` 判定（此前只判 `length > 0`）——避免出现"点开是空的"折叠面板；这条同时让 `tool_call`/`message` 的边界更严谨。
3. **不改错误与消息**：错误必须一眼看到（S34），消息是阅读主体（S23/S27 Markdown）——它们保持 `inline`。
4. **详细日志（trace）不动**：那是原始事件视图，摘要一行 + payload 开关（S35），本来就"折叠"在开关后面。
5. **纯函数先行**：只改 `eventRow`，用例钉住文案/`bodyMode`，组件零改动。

## 4 实现步骤

- `web/src/lib/event-display.ts`：`eventRow` 把 `thought` 并入 `collapsed` 分支；引入 `hasBody`（trim 后判空）；更新 `EventRow.bodyMode` 与函数注释。
- `tests/unit/web/event-display.test.ts`：思考用例改为断言 `bodyMode: 'collapsed'`，并补"空白正文 → `none`（无空面板）"。
- 文档回写：`prd` **D44** + FR-30 补注、`ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s41`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `event-display.test.ts`（思考折叠 / 空白正文退化 / 错误仍 inline / 工具调用与工具结果口径不变） |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | ① 让 Agent 干活 → 会话流里思考行默认只有标题 ② 点击展开看到思维链 ③ 工具调用行的折叠行为不变 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 折叠后"看不到模型在想什么"（与 S40 的诉求相反） | 标题保留 + 点击即展开；且思考是"过程信息"，默认收起符合 S28 已确立的口径 |
| 空白正文的空面板 | `hasBody`（trim 判空）→ `bodyMode: 'none'`，用例覆盖 |
| 展开状态在刷新/新事件后丢失 | `Collapse` 未受控（同 S28 工具调用），刷新后回到折叠——与既有行为一致 |
