# 修改记录 · S24 工具调用/结果不显示的缺陷修复（事件字段契约对齐）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s24-tool-event-fields.md](../plan/2026-09-16-s24-tool-event-fields.md)
> 关联设计：[ui.md](../design/ui.md) §4

## 1. 现象 / 根因

用户报告：**"工具结构不显示"**、**"工具结果不显示，告诉用户调的什么工具"**。

会话流里工具调用行只显示「工具调用 **工具**」（工具名丢失、参数全空），结果行把 payload 当 JSON 串显示。

**根因是事件 payload 字段契约不一致**——生产者在 `src/application/agent-loop/strategies.ts` 写的是：

| 事件 | 真实 payload（生产者） | S22 前端 / S21 `session_recent` 读的字段 |
| --- | --- | --- |
| `tool_call` | `{ tool, callId, input }`（`input` = 参数 JSON 文本，≤400 字符） | `name` / `args` → **undefined** |
| `tool_result` | `{ tool, callId, ok, summary }`（`summary` = 结果文本，≤2000 字符） | `text` → **undefined** → 退化成 `JSON.stringify(payload)` |

**为什么测试没拦住（本轮最重要的教训）**：S21 我写用例时**凭印象手写了 fixture**（`{ name, args }`），于是"实现与测试一起错"；而既有验收脚本用的却是真实字段 `payload['tool']`——两套字段并存，没有任何断言把它们对齐。因此本轮除修实现外，**把 fixture 换成生产者真实形态，并加了一条真实链路的钉子断言**。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web（新增） | `web/src/lib/event-display.ts` | 抽出"事件 → 展示文本"纯函数：`toolNameOf`（读 `tool`，兼容 `name`）、`toolInputOf`（读 `input`，兼容 `args`；JSON 能 parse 就美化两空格缩进，截断/非法则原样）、`eventBody`（工具调用=参数、工具结果=`summary`、思考/错误=`text`）、`eventLabel`（`工具调用 <name>` / `工具结果（失败） <name>`）、`isToolFailed`（`ok === false`）、`messageTextOf`（`text` 或 `content.text`）；文件头写明**字段契约与生产文件** |
| web | `web/src/pages/SessionPanel.tsx` | 删除组件内的 `eventText`/`toolName`/`eventBody`/`isToolFailed`，改用 lib；标题改用 `eventLabel(event)`、消息用 `messageTextOf(event)` |
| 后端 | `src/infra/tools/builtin/memory.ts` | `session_recent` 的 `summarizeEvent` 修同一处错配：`tool_call` 读 `tool`/`input`、`tool_result` 读 `ok`/`summary` 且**结果行带工具名**（`工具结果（成功 fs_read_file）：…`）；保留旧键兜底 |
| tests（新增） | `tests/unit/web/event-display.test.ts` | 7 条：工具名（`tool` 与兼容 `name`、缺失退化为「工具」）、参数格式化、截断原样显示、结果文本与失败标记、思考/错误、消息两种形态、无参数不显示 `undefined` |
| tests | `tests/integration/server/memory-api.test.ts` | fixture 换成**生产者真实 payload**；断言渲染含工具名、参数前缀与结果文本 |
| tests | `tests/acceptance/prd-section9.test.ts` | 新增**真实链路钉子**：用真实 loop 产出的 `tool_call`（`task_assign`）调 `session_recent`，断言渲染里既有工具名又有参数前缀 |
| docs | `docs/design/ui.md`、`docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md`、验收阶段清单 | 工具行口径回写；阶段索引与验收记录增 S24、清单加 `s24` |

**未改**：事件 payload 本身（生产者契约不动）；`keyword-index` 的同类问题（见遗留）；后端接口。

## 3. 关键决定

1. **把展示映射抽成纯函数模块**（`web/src/lib/event-display.ts`）：这类"字段名对不上"的缺陷落在 React 组件里只能靠点验发现；抽出来后**能被 node 侧 vitest 直接单测**（与 S23 的 Markdown 解析器同一手法）。
2. **fixture 照抄生产者**并在注释里点名生产文件；同时**兼容旧键**（`name`/`args`/`text`/`result`）以免旧日志显示空白。
3. **加"真实链路钉子"**：前端不能被 node 测试驱动，唯一能同时覆盖"生产者写的字段 + 消费者读的字段"的办法，是在验收脚本里用**真实 loop 事件**去调 `session_recent` 并断言渲染结果。
4. **结果行也带工具名**：用户明确要"告诉用户调的什么工具"，因此前端标题与后端行都带名字。
5. **参数尽量格式化**：`input` 是 JSON 文本，能 parse 就美化显示，让"结构"看得清；被截断（尾随 `…`）或非法时原样显示，不丢字符。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（src + web 两侧） |
| 前端单测 | `tests/unit/web/` **18 passed**（markdown 11 + event-display 7） |
| 全量测试 | `npm test` **48 files / 322 tests 全绿**（含新增的真实链路钉子） |
| 覆盖率门禁 | `npm run coverage` 140/140；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-C05vfHbu.js`） |
| **未覆盖** | 前端渲染层仍无 DOM 测试：需用户刷新后确认"工具调用行有真实工具名 + 参数、结果行有结果文本并带工具名、失败标红" |
| 说明 | 与 S4/S7/S12/S15~S23 的交付口径一致；本轮把"fixture 必须来自生产者"写进了测试注释与修改记录 |

## 5. 遗留

- **`keyword-index` 的同类错配**（既有 S5 缺陷，本轮未改）：`src/infra/indexer/keyword-index.ts` 的 `tool_call` 分支读 `payload['args']`，而生产者写的是 `input` → 全文索引里只落了工具名、没落参数。影响的是**检索质量**（不影响展示），建议与其它索引口径一起修。
- 事件 payload 仍是 `Record<string, unknown>`（D18-⑤ 单事件规范），**没有编译期字段约束**：前端（`web/src`）被 ESLint 禁止依赖服务端源码，无法共享类型/常量，因此只能靠"真实链路钉子 + 注释指路"防漂移。根治方案（如把事件字段常量放到双方都能引用的中立位置）需先调整层边界，属独立设计议题。
- 前端渲染层（`components/Markdown.tsx`、SessionPanel 的行渲染）仍无 DOM 测试；若后续前端逻辑继续变多，建议单独立项引入 `jsdom` + Testing Library。
