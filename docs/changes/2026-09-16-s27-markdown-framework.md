# 修改记录 · S27 改用成熟框架渲染 Markdown（react-markdown + remark-gfm）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s27-markdown-framework.md](../plan/2026-09-16-s27-markdown-framework.md)
> 关联设计：[ui.md](../design/ui.md) §4、[architecture.md](../design/architecture.md)、[prd](../requirements/prd.md) D32 / FR-30

## 1. 需求 / 问题

用户先指出**表格没渲染**（S23 的自研解析器把表格列进了"刻意不做"），随后明确指令：**"请使用框架渲染 markdown"**。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 依赖 | `package.json`（+ `package-lock.json`） | **新增 devDependencies**：`react-markdown@10.1.0`、`remark-gfm@4.0.1`（项目把 React/antd 等前端运行库放 devDependencies——产物是构建后的 `web/dist`，故同样放 dev） |
| 前端 | `web/src/components/Markdown.tsx` | **重写为框架渲染**：`<ReactMarkdown remarkPlugins={[remarkGfm]} components={{…}}>`；`components` 只覆写样式（表格 + 横向滚动、代码块等宽浅底、引用左边框、标题降级粗体、链接新窗口、行内代码底色），**不启用 `rehype-raw`、不加自定义 `urlTransform`**（安全交给框架默认：不注入 HTML + URL 白名单） |
| 前端（删除） | `web/src/lib/markdown.ts` | 自研零依赖解析器整体删除（避免两套解析器分叉） |
| 测试（删除） | `tests/unit/web/markdown.test.ts` | 自研解析器的 14 条用例删除（框架解析正确性由其上游保证；本轮不再维护自己的解析器） |
| docs | `prd`（**D32** + FR-30 补注）、`design/ui.md` §4、`design/architecture.md`（前端技术栈）、`design/abstraction.md`（§1 原则的显式例外）、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：`web/src/lib/event-display.ts` 与其单测（展示映射仍是我们自己的逻辑）；会话流其它条目（思考/工具调用/工具结果/错误仍是等宽纯文本，S22/S26 口径）；后端与接口。

## 3. 关键决定

1. **选 `react-markdown` + `remark-gfm`**：与"渲染成 React 元素"的现有方式天然契合，**默认不注入 HTML**（无需再引 `DOMPurify`）；`remark-gfm` 一次带来表格/删除线/任务列表/自动链接/嵌套列表。`marked`/`markdown-it` 产出 HTML 字符串，必须额外引 sanitizer，安全面更大。
2. **这是"零重型依赖"原则的显式例外**（用户直接指令）：项目此前两次拒绝新增依赖（S7 拒 React Flow、S9 拒覆盖率工具链），因此本次在 prd D32、`abstraction.md` §1、`architecture.md` 与本文四处写明"例外 + 理由 + 代价"。
3. **删掉自研解析器，不留双轨**：S24 的教训正是"两套真相必然分叉"。现在解析交给框架，我们只保留展示映射（`event-display.ts`）的单测。
4. **样式用 `components` 覆写，解析行为保持默认**：安全策略也保持默认（不注入 HTML、URL 白名单），不自定义以免埋雷。
5. **代价如实记录**：产物 1,193 kB → 1,346 kB（gzip 375 → 422 kB，**+47 kB gzip**）。若要压，可把渲染器改成动态 `import()`（记为遗留）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 安装 | `npm install --save-dev react-markdown@10.1.0 remark-gfm@4.0.1` → `added 96 packages`（含 micromark/mdast/unified 等传递依赖） |
| typecheck | `npm run typecheck`（`tsconfig.json` + `web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误（`web/src` 不依赖服务端源码的边界仍通过） |
| 构建 | `npm run build` 通过；产物 **`web/dist/assets/index-CbVCUHlb.js` 1,346.52 kB（gzip 421.94 kB）**，上一版 `index-C05vfHbu.js` 为 1,193.60 kB（gzip 375.26 kB） |
| 全量测试 | `npm test` **48 files / 318 tests 全绿**（删掉自研解析器 14 条用例：329 → 318） |
| 覆盖率门禁 | `npm run coverage` 141/141（前端不在门禁范围，符合既有口径）；`npm run ratchet` 违规 **0** |
| 活体 | `GET /assets/index-CbVCUHlb.js` 返回 200 |
| **未覆盖** | 无浏览器自动化：需用户刷新后确认 ① GFM 表格渲染成表格且过宽时横向滚动 ② 删除线/任务列表/自动链接可用 ③ 代码块、引用、列表观感与之前一致 |
| 说明 | 与 S4/S7/S12/S15~S26 的交付口径一致 |

## 5. 遗留

- **产物体积 +47 kB（gzip）**：Markdown 渲染器与 GFM 插件链一次性打进主 chunk。优化方向：对 `Markdown` 组件做 `React.lazy` + 动态 `import()`（消息渲染时才加载），或按需要改用更小的实现——属优化项，需单独确认。
- **前端展示层仍无 DOM 测试**：框架行为由上游测试保证；我们自己的展示映射有单测；DOM 级测试（jsdom + Testing Library）仍待单独立项。
- **`abstraction.md` §1「零重型依赖」原则已被本次例外打破一次**：文档已标注例外与理由。若后续继续引入前端依赖，建议把"依赖准入"写成正式流程（谁批、什么标准），而不是逐次口头例外。
- 表格内**转义竖线 `\|`**、图片、语法高亮：框架其实大多支持（图片/高亮需额外插件或样式），当前未配置；需要时按需加插件并记录。
