# S23 方案：对话消息按 Markdown 渲染

> 日期：2026-09-16　类型：展示增强（用户直接指令）　真源：`design/ui.md` §4（对话导航 · 会话流）、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s23-message-markdown.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"对话中的消息 markdown 渲染显示"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **对话消息按 Markdown 渲染** | `message` 事件（用户与 Agent 两侧）不再以纯文本 + `pre-wrap` 显示，而是渲染为标题/段落/列表/代码块/引用/分隔线/行内强调 |
| R2 | **代码块可读** | ``` 围栏代码块保留原始换行与缩进、等宽字体、可横向滚动；`**` 等记法在代码块内**不被解析** |
| R3 | **不引入新依赖** | `package.json` 依赖不变；解析器自研（与 S7 自研 SVG 画布同一口径），避免为渲染引入 `react-markdown`/`marked` 等链条 |
| R4 | **安全** | 全程**不注入 HTML**（不用 `dangerouslySetInnerHTML`，尖括号按纯文本）；链接只放行 `http(s)`/`mailto`/站内相对地址，`javascript:`、`data:` 等按纯文本原样显示 |
| R5 | **不丢内容** | 不支持的语法（表格、图片、嵌套列表、HTML 标签）按纯文本原样呈现，不吞字符 |
| R6 | 其它事件不动 | 思考（`thought`）/工具调用/结果/错误仍按 S22 的纯文本 + 等宽小字展示（本轮只改对话消息） |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` | 消息气泡：`<div>{eventText(event)}</div>`，容器 `whiteSpace: 'pre-wrap'` —— Agent 输出的标题、列表、代码块全变成一坨纯文本 |
| 前端 | `web/src/` 结构 | 只有 `api/`、`hooks/`、`pages/`（无 `components/`、`lib/`） |
| 依赖 | `package.json` | 无任何 Markdown 相关依赖（项目自 S0 起保持极简依赖 + 依赖棘轮门禁） |
| 约束 | `eslint.config.js` | `web/src/**` **不得**依赖 `**/src/**`（前端只能经 REST/WS 契约交互）→ 解析器必须放在 `web/src` 内 |
| 约束 | `tsconfig.json`（node 侧） | `include` 覆盖 `src/**/*.ts` + `tests/**/*.ts`，无 `jsx` 设置 → **纯 `.ts` 解析器**才能被 node 侧单测引用（`.tsx` 会报 "Cannot use JSX unless '--jsx' is provided"） |

## 3 关键决定

1. **自研零依赖解析器**（`web/src/lib/markdown.ts`，纯函数）+ **渲染组件**（`web/src/components/Markdown.tsx`）分层：解析器不含 react/DOM，因此**能被现有 node 侧 vitest 直接单测**（这是本仓库第一次让前端逻辑进入测试套件）；渲染层只做"块 → React 元素"的机械映射。
2. **不做 HTML 注入**：Markdown 的 HTML 透传是最常见 XSS 面；本项目消息来自模型与用户，一律按纯文本处理，渲染层只创建 React 元素（React 自动转义）。链接再做**协议白名单**（`http(s)`/`mailto`/`/`、`#` 开头），其余原样当文本。
3. **支持子集**：标题（`#`~`######`）、段落（**单换行 = 换行**，聊天场景更符合直觉）、围栏代码块（含未闭合时吃到文末，不丢内容）、无序/有序列表、引用、分隔线、行内 `**粗**`/`*斜*`/`~~删~~`/`` `代码` ``/`[链接](url)`。
4. **刻意不做**：表格、图片、嵌套列表、语法高亮、任务列表勾选框——都是"要么加很多代码、要么引入依赖"的功能，先按最小可用集落地（记入遗留）。
5. **只改对话消息**：思考/工具调用/结果/错误维持 S22 的等宽纯文本（工具输出常含代码与日志，套 Markdown 反而易失真）。
6. **新目录约定**：前端首次出现 `web/src/components/`（可复用渲染组件）与 `web/src/lib/`（纯逻辑），后续前端复用件按这两个目录归位。

## 4 实现步骤

- `web/src/lib/markdown.ts`：`parseMarkdown(text)`（块级）+ `parseInline(text)`（行内）+ `safeHref(href)`（协议白名单）+ 类型 `MarkdownBlock`/`InlineNode`。
- `web/src/components/Markdown.tsx`：`<Markdown text={...} />`，`useMemo` 缓存解析结果；段落/标题/代码块/列表/引用/分隔线分别映射为元素，行内节点递归渲染。
- `web/src/pages/SessionPanel.tsx`：消息气泡内的 `<div>{eventText(event)}</div>` → `<Markdown text={eventText(event)} />`。
- `tests/unit/web/markdown.test.ts`：11 条解析器用例（空文本、段落/换行、标题、行内五类、协议白名单、围栏代码块（含空行与 `**` 不解析）、未闭合围栏、列表、引用/分隔线、HTML 当文本、段落不吞后续块）。
- 文档回写：`ui.md` §4、`prd` **D29** + FR-30、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s23`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .`（含 web 不得依赖 src 的边界） |
| 单测 | `npx vitest run tests/unit/web/markdown.test.ts`（11 条） |
| 构建 | `npm run build` |
| 产物冒烟 | 产物含解析器与渲染组件相关文案（如 `whiteSpace` 代码块样式不易断言，改为断言构建成功 + 体积变化合理） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` |
| **交互验证（用户）** | 无浏览器自动化：刷新后确认 ① Agent 回复里的标题/列表/代码块正常显示 ② 代码块保留缩进、可横向滚动 ③ 聊天记录里普通文本仍是普通文本 |
| 说明 | 与 S4/S7/S12/S15~S22 的交付口径一致；**本轮首次给前端逻辑补了单测**（解析器纯函数化是前提） |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 自研解析器对畸形输入表现异常（未闭合记号等） | 解析器只做"能识别就渲染、识别不了当文本"，**不抛异常、不吞字符**；用例覆盖未闭合围栏与不安全链接 |
| 长代码块撑破气泡 | 代码块等宽 + `overflowX: auto`；行内代码不换行 |
| 模型输出大量 Markdown 造成"过度排版" | 只渲染上述子集，不做自动链接、不做表格推断 |
| 前端逻辑进不了 node 测试（JSX） | 解析器与渲染层**文件分离**，只把纯 `.ts` 交给测试 |
| 渲染层行为（元素映射）缺自动化 | 单元测试覆盖解析；渲染层靠 build + 代码审阅 + 用户点验；后续如需可引入 DOM 测试环境（P1） |
