# S28 方案：工具调用参数默认折叠

> 日期：2026-09-16　类型：UI 规则调整（用户直接指令）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s28-tool-call-args-collapsed.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"工具调用参数默认不展开"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 工具调用条目的**参数默认折叠** | 会话流里工具调用行只显示 `工具调用 <工具名> · #seq · turn N`；参数**不展开**，点击标题才展开看参数结构 |
| R2 | 展开后仍是格式化参数 | 展开内容为 S24 的格式化 JSON（能 parse 就两空格缩进），等宽小字、可换行 |
| R3 | 无参数时不出现空折叠 | 参数为空时退化为**纯标题行**（不显示可点开的空面板） |
| R4 | 其它条目不受影响 | 思考/错误仍直接展示正文；**工具结果仍只有工具名**（S26） |
| R5 | 规则可单测 | "默认折叠"由纯函数 `eventRow` 的 `bodyMode: 'collapsed'` 表达并有用例 |

## 2 现状与影响面

| 面 | 位置 | 现状（S24 之后） |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` | 工具调用行 = `工具调用 <name> · #seq · turn N` + **参数 JSON 直接铺开**（长参数会把会话流撑得很乱） |
| 前端 | `web/src/lib/event-display.ts` | `eventRow(event) → { label, body, showMeta }`（S26 引入的行渲染规则），没有"正文怎么呈现"的表达 |
| 依赖 | `antd` | S22 曾移除 `Collapse`（工作日志折叠），本轮为"参数折叠"重新引入（antd 已在依赖里，无新增包） |

## 3 关键决定

1. **把"正文呈现方式"加进行渲染规则**：`EventRow.bodyMode: 'inline' | 'collapsed' | 'none'`——这样"S28：参数默认折叠"不是散在 JSX 里的行为，而是**可单测的规则**（延续 S26 的做法）。
2. **用 antd `Collapse`（`ghost` + `size="small"`）而不是自研展开**：项目已依赖 antd（无新增包），`Collapse` 自带展开箭头、键盘可达与受控行为，比自写 `useState` 更省代码、更一致（S22 删掉它是因为"工作日志包装"被取消，不是因为组件本身有问题）。
3. **默认折叠 = 不传 `defaultActiveKey`**：不给任何默认展开项。
4. **无参数退化**：`body` 为空时 `bodyMode: 'none'`，渲染为普通标题行——避免出现"点开是空白"的假折叠。
5. **只改工具调用**：思考/错误继续 inline；工具结果继续"只有工具名"（S26）。

## 4 实现步骤

- `web/src/lib/event-display.ts`：`EventRow` 增 `bodyMode`；`eventRow` 按 kind 决定（tool_call → `collapsed`（无参数则 `none`）；tool_result → `none`；其余有正文 → `inline`，无正文 → `none`）。
- `web/src/pages/SessionPanel.tsx`：`showMeta` 且 `bodyMode === 'collapsed'` 时用 `Collapse`（ghost、单面板、label 为 `标题 · #seq · turn N`、children 为参数 `<pre>`）；`bodyMode === 'inline'` 时照旧直接渲染正文；重新引入 `Collapse` import。
- `tests/unit/web/event-display.test.ts`：更新 `eventRow` 期望（新增 `bodyMode`），补"无参数 → `none`"用例。
- 文档回写：`prd` FR-30 补注 + **D33**、`design/ui.md` §4、`README.md`/`plan/development.md`/`testing/plan.md` + 验收阶段清单加 `s28`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/web/`（`eventRow` 的 `bodyMode` 断言） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| **交互验证（用户）** | 刷新后确认：工具调用行默认只有标题 + 展开箭头；点击后看到格式化参数；工具结果行仍只有工具名 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 多一层点击才能看到参数 | 这是用户明确要的默认态；参数仍在同一条目内可展开（不用跳页/翻日志） |
| 折叠面板在窄气泡里挤压 | `Collapse ghost` 无边框、`pre` 允许换行（`whiteSpace: pre-wrap` + `break-all`） |
| 会话流 DOM 变多（每条调用一个 Collapse） | antd 折叠面板在未展开时不渲染子内容（惰性），影响可控 |
| 与 S26 结果行规则互相干扰 | 两条规则都在 `eventRow` 内按 kind 分支，单测同时覆盖 |
