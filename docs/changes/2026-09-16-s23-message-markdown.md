# 修改记录 · S23 对话消息按 Markdown 渲染

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s23-message-markdown.md](../plan/2026-09-16-s23-message-markdown.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) D29 / FR-30

## 1. 需求 / 问题

用户口径：**"对话中的消息 markdown 渲染显示"**。

现状：消息气泡是 `<div>{eventText(event)}</div>` + `whiteSpace: 'pre-wrap'` —— Agent 回复里的标题、列表、代码块全被压成一坨等宽纯文本，读起来很糟。

## 2. 改动范围（仅前端 + 文档 + 测试）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web（新增） | `web/src/lib/markdown.ts` | **零依赖 Markdown 解析器（纯函数）**：`parseMarkdown`（块级：段落/标题/围栏代码块/列表/引用/分隔线）、`parseInline`（行内：粗/斜/删/行内代码/链接）、`safeHref`（`http(s)`/`mailto`/站内相对地址白名单）+ 类型 `MarkdownBlock`/`InlineNode` |
| web（新增） | `web/src/components/Markdown.tsx` | 渲染组件 `<Markdown text={…} />`：把块映射为 React 元素（`useMemo` 缓存解析）；**不使用 `dangerouslySetInnerHTML`**，不做 HTML 透传 |
| web | `web/src/pages/SessionPanel.tsx` | 消息气泡内改为 `<Markdown text={eventText(event)} />`（用户与 Agent 两侧一致）；思考/工具调用/结果/错误维持 S22 的等宽纯文本 |
| tests（新增） | `tests/unit/web/markdown.test.ts` | 11 条解析器用例：空文本、段落与单换行、标题、行内五类、协议白名单（`javascript:`/`data:` 不通过）、围栏代码块（保留空行与 `**`）、未闭合围栏吃到文末、无序/有序列表、引用/分隔线、HTML 当纯文本、段落不吞后续块 |
| docs | `docs/requirements/prd.md` | 新增 **D29**；FR-30 补"对话消息按 Markdown 渲染"；文件头日期行增补 |
| docs | `docs/design/ui.md` | §4「会话流内容」条目补 Markdown 渲染口径（支持子集 + 安全边界 + 不做项） |
| docs | `docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md` | 阶段索引 `S0`~`S23` + S23 行；§6 验收记录 |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 5 阶段清单加 `s23` |

**未改**：`package.json` 依赖（**零新增依赖**）；后端与接口；思考/工具/结果/错误的展示方式。

## 3. 关键决定

1. **自研零依赖解析器，而不是装 `react-markdown`**：与 S7"自研零依赖 SVG 画布（拒绝 React Flow）"同一口径；本项目自 S0 起有依赖棘轮门禁，为渲染引入一条依赖链不值当。
2. **解析器与渲染层拆成两个文件**：`lib/markdown.ts` 是**纯函数、不含 react/DOM**，因此可被现有 node 侧 vitest 直接引用（`.tsx` 会因 node tsconfig 没有 `jsx` 而无法编译）；这是本仓库**第一次把前端逻辑纳入测试套件**。渲染层只做机械映射，靠 build + 审阅。
3. **不做 HTML 透传 + 链接协议白名单**：消息来自模型与用户，Markdown 的 HTML 能力是典型 XSS 面；渲染层只创建 React 元素（React 自动转义），`[x](javascript:…)` 这类链接**不生成 `a` 节点**，原样当文本。
4. **支持子集，刻意不做表格/图片/嵌套列表/语法高亮**：够读 Agent 输出即可；做不全的东西宁可当纯文本显示，也不做半成品（记入遗留）。
5. **只改对话消息**：工具输出常含代码与日志，套 Markdown 反而容易失真，维持等宽纯文本。
6. **新目录约定**：前端新增 `web/src/components/`（可复用渲染件）与 `web/src/lib/`（纯逻辑），后续前端复用件按此归位。
7. **单换行即换行**：聊天场景里用户/A模型常按行写，按 CommonMark 的"软换行合并成一段"会让内容挤成一坨，这里显式把单换行渲染为 `<br/>`。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsconfig.json` 含 tests→web 引用 + `web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误（含 `web/src/**` 不得依赖 `src/**` 的边界检查通过） |
| 单测 | `tests/unit/web/markdown.test.ts` **11 passed** |
| 全量测试 | `npm test` **47 files / 315 tests 全绿**（304 + 11） |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-CqAo6FKt.js`） |
| 覆盖率门禁 | `npm run coverage` 140/140（前端文件不在门禁范围，符合既有口径）；`npm run ratchet` 违规 0 |
| **未覆盖** | 渲染层（元素映射与样式）无 DOM 测试环境：需用户刷新后确认 ① 标题/列表/代码块显示正常 ② 代码块保留缩进且可横向滚动 ③ 普通文本仍是普通文本 |
| 说明 | 与 S4/S7/S12/S15~S22 的交付口径一致；本轮新增的解析器用例是本仓库首批前端逻辑测试 |

## 5. 遗留

- **不支持**：表格、图片、嵌套列表、任务列表勾选框、自动链接、语法高亮——需要时另立需求（表格若要支持，建议同时补"窄栏横向滚动"）。
- 渲染层没有 DOM 级测试（项目无 jsdom/Testing Library）：若后续前端逻辑变多，建议引入 `jsdom` + `@testing-library/react` 作为独立阶段（会新增 devDependencies，需先确认）。
- 代码块无语言标签展示、无复制按钮（当前只保留等宽 + 横向滚动）。
- 消息里的相对链接（`/projects/…`）会在新标签打开但前端没有路由，实际会整页跳转；如需要，应改成前端内跳（属交互增强）。
- 同一条消息内的 `#seq · message · user · turn N` 元信息仍保留（S22 之前就有）；若觉得噪音，可另立一条 UI 精简需求。
