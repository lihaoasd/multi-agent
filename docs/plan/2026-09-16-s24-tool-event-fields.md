# S24 方案：工具调用/结果不显示的缺陷修复（事件字段契约对齐）

> 日期：2026-09-16　类型：缺陷修复（用户报告："工具结构不显示 / 工具结果不显示，告诉用户调的什么工具"）　真源：`design/ui.md` §4
> 关联：`docs/changes/2026-09-16-s24-tool-event-fields.md`、`docs/plan/development.md`

## 1 需求

用户报告：**"工具结构不显示"**、**"工具结果不显示，告诉用户调的什么工具"**。

现象（会话流）：工具调用行只显示「工具调用 **工具**」（工具名丢了、参数完全看不见）；工具结果行把整个 payload 当 JSON 串显示或干脆空白。

## 2 根因（字段契约不一致）

生产者在 `src/application/agent-loop/strategies.ts` 写事件时的 payload 是：

| 事件 | 真实 payload | 我按 S22/S21 读取的字段（错） |
| --- | --- | --- |
| `tool_call` | `{ tool, callId, input }`（`input` = `summarizeArgs()` 后的 **JSON 文本**，≤400 字符） | `name` / `args` → 都 undefined |
| `tool_result` | `{ tool, callId, ok, summary }`（`summary` = 结果文本，≤2000 字符） | `text` → undefined，于是退化成 `JSON.stringify(payload)` |

后果：`toolNameOf` 拿不到名字 → 显示兜底文案「工具」；`toolBody` 拿不到参数 → 空；结果行走通用兜底 → 显示原始 JSON。

**为什么测试没拦住**：我写 S21 用例时**手写 fixture 用了 `name`/`args`**（凭印象而非照抄生产者），于是"实现与测试一起错"，而既有验收脚本用的 `payload['tool']` 是真的——两套字段并存却没人对比。这是本轮的教训（见 §5）。

## 3 影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` | S22 就地写的 `toolName()`/`eventBody()`/`isToolFailed()`，按 `name`/`args`/`text` 读 → 全错 |
| 后端 | `src/infra/tools/builtin/memory.ts`（`session_recent` 的 `summarizeEvent`） | S21 同样按 `name`/`args`/`text` 读 → Agent 自查时看到「工具调用 ? {}」 |
| 其它消费者 | `src/infra/indexer/keyword-index.ts` | `tool_call` 读 `payload['args']`（生产者也写 `input`）→ 索引里只落工具名（**既有 S5 缺陷，本轮不动**，记入遗留） |
| 事件契约 | `src/ports/session.ts` | payload 是 `Record<string, unknown>`（D18-⑤ 单事件规范），**没有编译期字段约束** |

## 4 关键决定

1. **前端把"事件→展示文本"抽成纯函数模块**：`web/src/lib/event-display.ts`（`toolNameOf`/`toolInputOf`/`eventBody`/`eventLabel`/`isToolFailed`/`messageTextOf`）。理由：这类"字段名对不上"的缺陷一旦落到 React 组件里就只能靠点验发现；抽成纯函数后**能被 node 侧 vitest 直接单测**（与 S23 解析器同一手法）。
2. **fixture 照抄生产者**：新单测的 payload 直接写成 `{ tool, callId, input }` / `{ tool, callId, ok, summary }`，并在注释里点名生产文件；同时**兼容旧键**（`name`/`args`/`text`）以免旧日志显示空白。
3. **加一条"真实链路钉子"**：在验收脚本里用**真实 loop 产出的** `tool_call`（`task_assign`）去调 `session_recent`，断言渲染里既有工具名又有参数前缀——这是唯一能同时覆盖"生产者写的字段"和"消费者读的字段"的手段（前端不能被 node 测试直接驱动）。
4. **结果行也带工具名**：用户明确要"告诉用户调的什么工具"，因此 `工具结果（成功 fs_read_file）：…`；前端标题同理，正文给结果文本（`summary`）。
5. **参数格式化**：`input` 是 JSON 文本，能 parse 就美化（两空格缩进）再显示，看清"结构"；被截断（尾随 `…`）或非法时原样显示，不丢字符。
6. **顺手修正 S21 的同一处错**（`session_recent`）——同一个契约错配，不修就等于 Agent 自查时也看不到工具名与参数。

## 5 实现步骤

- `web/src/lib/event-display.ts`（新增，纯函数，含字段契约注释）。
- `web/src/pages/SessionPanel.tsx`：删除组件内的 `eventText`/`toolName`/`eventBody`/`isToolFailed`，改用 lib；标题用 `eventLabel(event)`；消息用 `messageTextOf(event)`。
- `src/infra/tools/builtin/memory.ts`：`summarizeEvent` 的 `tool_call`/`tool_result` 改为读 `tool`/`input`/`summary`（保留兜底），结果行带工具名。
- `tests/unit/web/event-display.test.ts`（新增 7 条）：工具名（`tool` 与兼容 `name`）、参数格式化、截断原样、结果文本与失败标记、思考/错误、消息两种形态、无参数时不显示 `undefined`。
- `tests/integration/server/memory-api.test.ts`：fixture 换成真实 payload，断言渲染含工具名与参数。
- `tests/acceptance/prd-section9.test.ts`：加"真实 `tool_call` ↔ `session_recent` 渲染"的钉子断言。
- 文档回写：`ui.md` §4（工具行口径）、`README.md`/`plan/development.md`/`testing/plan.md` + 验收阶段清单加 `s24`。

## 6 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/web/`（11 + 7 条） |
| 集成 | `tests/integration/server/memory-api.test.ts`（`session_recent` 渲染含工具名/参数/结果文本） |
| 验收钉子 | `tests/acceptance/prd-section9.test.ts`（真实 loop 的 `tool_call` → `session_recent` 渲染一致） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| **交互验证（用户）** | 刷新后确认：工具调用行显示**真实工具名** + 格式化参数；结果行显示结果文本并带工具名；失败时标红 |

## 7 风险

| 风险 | 对策 |
| --- | --- |
| 事件 payload 无编译期约束，未来再漂移 | 本轮用"真实链路钉子 + 生产文件注释"降风险；根治需给事件 payload 定义类型/常量（跨 web/src 无法共享，需另立方案） |
| 旧日志 payload 字段不同 | 兼容读取（`tool`←`name`、`input`←`args`、`summary`←`text`/`result`） |
| 参数 JSON 很长撑满气泡 | 生产者已截断到 400 字符；美化后仍是等宽小字 + `maxWidth: 85%` |
