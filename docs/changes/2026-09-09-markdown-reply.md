# 2026-09-09 助手回复 Markdown 渲染 + think 与回复视觉再区分

> 类别：changes · 需求来源：用户「1. think 和助手回复的消息不应该放一起 2. 助手回复的消息应该 markdown 显示」

## 需求/问题

1. think（模型推理）与助手回复必须分开看，不能像同一条消息（上一轮已拆成两块，本轮再强化视觉区分）。
2. 助手回复目前按纯文本直出，模型输出的标题/列表/代码块/表格等 Markdown 全部「摊平」了，需要渲染。

## 改动范围

### A. 助手回复 Markdown 渲染（新增 `web/markdown.js`）

- 无依赖、无构建的自研渲染器（`renderMarkdown(text)`），与页面同源静态加载；
- 支持：标题、段落、围栏代码（带语言 class）、行内代码、粗体/斜体/删除线、链接、
  有序/无序列表（含缩进续行）、引用、分割线、GFM 风格管道表格；段落内单换行转 `<br>`；
- **安全**：先整体 HTML 转义再渲染，链接仅放行 `http/https/mailto`（`javascript:` 等按纯文本保留），
  外链带 `rel="noopener noreferrer"`；图片语法降级为链接（不加载远程图片）。
- `web/app.js`：
  - 顶部 `import { renderMarkdown } from './markdown.js'`；
  - 新增 `fillMessageBody(el, text, asMarkdown)`：助手消息用 Markdown，用户消息/思考块保持纯文本；
  - 历史渲染（`renderEvent`）与向前翻页（`loadOlder`）统一走该函数；
  - 流式：累计原始文本 `st.raw`，`renderStreamMarkdown()` 按 `requestAnimationFrame` 节流重渲染，
    `message.commit` 时再整体刷新一次，保证末尾分片也格式化。
- `web/style.css`：新增助手气泡内 Markdown 元素样式（标题/列表/代码块/引用/表格/链接/hr）。

### B. think 与回复的视觉再区分

- 思考块改为「注释」样式：去掉气泡底色，改为左侧虚线竖条 + 缩进 + 更小字号；
- 头部保留 `${名字} · 🧠 思考过程`（流式中为「思考中…」），可点击折叠；
- 数据层不变：思考仍只进 `thought` 事件（纯文本展示），回复进 `message` 事件（Markdown 展示）。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **127 用例全绿**
  （118 + 新增 `tests/markdown.test.js` 9 例：XSS 转义、危险协议链接、代码块/行内代码转义、
  标题/列表/表格/引用/hr、段落换行、任务分派脚注列表）。
- 静态资源实测：`/markdown.js` 200 且 `Content-Type: application/javascript`、含 `export function renderMarkdown`；
  `/app.js` 含 `from './markdown.js'`、`fillMessageBody`、`renderStreamMarkdown`；`/style.css` 含 Markdown 与思考块样式。
- `npx prettier --check` 对改动的 4 个前端文件通过（已 `--write` 统一格式）。

## 遗留（说明）

- 前端仍无浏览器 e2e；Markdown 渲染以「纯函数单测 + 静态资源校验」验证，未做真实点击回归。
- 渲染器为受控子集：不支持嵌套列表缩进层级、脚注、数学公式、HTML 内联（HTML 一律转义）。
- 思考块默认展开，可折叠；未做折叠偏好记忆。
