# S27 方案：改用成熟框架渲染 Markdown（react-markdown + remark-gfm，支持表格）

> 日期：2026-09-16　类型：技术选型变更（用户直接指令："请使用框架渲染 markdown"）　真源：`design/ui.md` §4、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s27-markdown-framework.md`、`docs/plan/development.md`

## 1 需求

用户口径：

1. 先指出**表格没渲染**（S23 的自研解析器把"表格"列进了"刻意不做"）；
2. 随后明确 **"请使用框架渲染 markdown"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **用成熟框架渲染** Markdown | 会话消息由 `react-markdown` + `remark-gfm` 渲染；自研解析器 `web/src/lib/markdown.ts` 与其单测删除 |
| R2 | **表格要能渲染** | GFM 管道表格渲染为带边框的 `<table>`（表头/数据行/列对齐），过宽时容器内横向滚动 |
| R3 | GFM 其它能力顺带获得 | 删除线、任务列表勾选框、自动链接、嵌套列表 |
| R4 | **安全不回退** | 不启用 `rehype-raw`（HTML 仍按纯文本），链接走框架内置 `defaultUrlTransform`（挡 `javascript:` 等） |
| R5 | 样式与原风格一致 | 表格边框/横向滚动、代码块等宽 + 浅底、引用左边框、链接新窗口打开、标题降级为粗体小标题 |
| R6 | 依赖门禁仍通过 | `npm run ratchet` 0 违规（六层依赖不受影响）；`package.json`/`package-lock.json` 记录依赖 |

## 2 现状与影响面

| 面 | 位置 | 现状（S23 之后） |
| --- | --- | --- |
| 前端 | `web/src/lib/markdown.ts` | 自研零依赖解析器（支持标题/段落/围栏代码/列表/引用/分隔线 + 行内），**不支持表格** → 用户贴的表格显示成原始竖线文本 |
| 前端 | `web/src/components/Markdown.tsx` | 把自研解析结果映射成 React 元素 |
| 测试 | `tests/unit/web/markdown.test.ts` | 11 条解析器用例（+本轮临时加的 3 条表格用例） |
| 依赖 | `package.json` | 无任何 Markdown 依赖（项目原则"零重型依赖"，abstraction.md §1） |
| 门禁 | `scripts/import-ratchet.mjs` | 只统计**六层越层 import**，不拦第三方依赖 → 新增依赖不会被 ratchet 拦，但属原则性变更，必须记录 |

## 3 关键决定

1. **选 `react-markdown` + `remark-gfm`**：与项目现有渲染方式（React 元素）天然契合——**默认不注入 HTML**（不用 `dangerouslySetInnerHTML`），无需额外引入 `DOMPurify`；`remark-gfm` 一次拿到表格/删除线/任务列表/自动链接/嵌套列表。对比 `marked`/`markdown-it`：后两者产出 HTML 字符串，必须再引 sanitizer，安全面更大。
2. **这是对"零重型依赖"原则的显式例外**：项目自 S7 起拒绝 React Flow（自研 SVG 画布）、S9 拒绝覆盖率依赖，均因"不引重型依赖"。本次是**用户直接指令**，因此按用户口径执行，并在 prd（D32）、`abstraction.md`、`architecture.md` 记录例外与代价（见 §6 风险：产物 +153 kB / gzip +47 kB）。
3. **删掉自研解析器与其单测**，不做双轨：两套解析器并存必然分叉（S24 的字段契约事故就是"两套真相"的教训）。框架的解析正确性由其上游测试保证，我们只保留**展示映射**（`lib/event-display.ts`）的单测。
4. **只用 `components` 覆写样式，不改解析行为**：不启用 `rehype-raw`、不加自定义 `urlTransform`，把安全交给框架默认策略（不注入 HTML + URL 白名单）；样式上给表格加滚动容器、代码块/引用/标题保持既有观感。
5. **不改会话流其它条目**：思考/工具调用/工具结果/错误仍是等宽纯文本（S22/S26 口径），Markdown 只用于对话消息。

## 4 实现步骤

- `npm install --save-dev react-markdown@10.1.0 remark-gfm@4.0.1`（项目把 React/antd 等前端运行库放在 `devDependencies`，产物是构建后的 `web/dist`，故同样放 devDependencies）。
- 重写 `web/src/components/Markdown.tsx`：`<ReactMarkdown remarkPlugins={[remarkGfm]} components={{…}}>{text}</ReactMarkdown>`，覆写 `a/p/h1~h6/ul/ol/blockquote/hr/pre/code/table/th/td`。
- 删除 `web/src/lib/markdown.ts` 与 `tests/unit/web/markdown.test.ts`（自研解析器与其用例）。
- 文档回写：`prd` **D32**（修订 D29 的②④）+ FR-30 补注、`design/ui.md` §4、`design/architecture.md`（前端技术栈）、`design/abstraction.md`（§1 原则的显式例外）、`README.md`/`plan/development.md`/`testing/plan.md` + 验收阶段清单加 `s27`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（记录体积变化） |
| 测试 | `npm test` 全绿（自研解析器用例已删，展示映射用例保留）；`npm run coverage` 141/141；`npm run ratchet` 0 |
| 活体 | 服务端静态服务新产物 200；刷新后贴一张 GFM 表格确认渲染为表格 |
| **交互验证（用户）** | 无浏览器自动化：请把之前那张「风险 | 影响 | 缓解」表格再贴一次（或看历史消息），确认渲染成表格、过宽时可横向滚动 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| **产物变大** | 实测 `index-C05vfHbu.js` 1,193 kB → `index-CbVCUHlb.js` 1,346 kB（gzip 375 kB → 422 kB，+47 kB）。已记录；若将来要压，可改为动态 `import()` 按需加载 Markdown 渲染器（属优化项） |
| 与"零重型依赖"原则冲突 | 属**用户直接指令**的例外，已在 prd D32、abstraction.md、architecture.md、本记录四处写明理由与代价 |
| 依赖升级带来的行为变化 | 版本锁在 `package.json`（`^10.1.0`/`^4.0.1`）与 `package-lock.json`；升级需跑一遍门禁与点验 |
| 两套 Markdown 实现并存导致分叉 | 明确删除自研实现与其用例，不留双轨 |
| 前端展示层仍无 DOM 测试 | 框架正确性由上游保证；我们的展示映射（`event-display.ts`）继续有单测；DOM 级测试仍需单独立项（遗留） |
