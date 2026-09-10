# 2026-09-09 思考过程默认折叠

> 类别：changes · 需求来源：用户「思考过程，默认不展开」

## 需求/问题

思考块此前默认展开（实时流式时直接把推理全文铺在会话流里，历史回放也是展开的），
会话被大段推理文本占满。要求：**思考过程默认折叠**，需要时点击展开。

## 改动范围

- `web/app.js`：
  - 新增统一构造器 `createThinkBlock(who, {live})`：默认 `think-body` 带 `hidden`（折叠）；
    折叠态标题为 `名字 · ▸ 🧠 思考过程（N 字）`，展开态 `▾`，点击切换并更新箭头与提示；
  - 历史回放 `appendThinkNode()` 与前向翻页 `buildThinkNode()` 均改用该构造器（默认折叠）；
  - 实时流式 `ensureThinkBlock()` 改用该构造器：收到 `thought.chunk` 时**只累计字数并更新标题**
    （不自动展开）；若用户中途点击展开，增量继续写入且保持展开；`message.commit` 调 `finish()`
    把标题从「思考中…」收敛为「思考过程（N 字）」；
  - 删除旧的 `appendThink()` 内联实现与 `thinkHead/thinkBody` 字段（合并为 `thinkApi`）。
- `README.md`：think 展示行补充「默认折叠、点击展开」。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **127 用例全绿**；
  `npx prettier --check web/app.js` 通过。
- 静态资源实测（起服务抓 `/app.js`）：`createThinkBlock` 存在、`think-body hidden` 默认折叠、
  `▸` 折叠箭头与「（N 字）」提示存在、旧的 `thinkHead`/`appendThink(` 已不存在。
- 局限（说明）：前端无浏览器 e2e，折叠交互以「静态资源校验 + 代码审查」验证，未做真实点击回归。

## 遗留（说明）

- 未做「折叠偏好记忆」（刷新后统一回到默认折叠）。
- 思考块仍完整落 `thought` 事件，展开即可看到全文（不受折叠影响）。
