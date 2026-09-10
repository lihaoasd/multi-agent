# 2026-09-09 think 与助手回复分块展示（不复用同一气泡）+ 只出思考的兜底

> 类别：changes · 需求来源：用户「think 和助手回复的消息不应该放一起」

## 需求/问题

开启 think 模式的模型会同时输出两路内容：推理（`reasoning_content`）与回复（`content`）。
平台数据层本就分列为 `thought` 事件与 `message` 事件，但**前端实时流式**把两者塞进了同一个
`.msg.agent` 气泡（思考块嵌在回复气泡内部）——看起来像"一条消息里混了思考和回复"。

## 改动范围

### A. 前端：思考块与回复气泡各自独立
- `web/app.js`：删除合并式的 `streamBox()`，改为两个独立构造器：
  - `ensureThinkBlock(sender)` → 独立 `.msg.think` 块（头部 `${名字} · 🧠 思考中…`，完成后收敛为「🧠 思考过程」，可点击折叠）；
  - `ensureAnswerBlock(sender)` → 独立 `.msg.agent` 气泡（头部名字 + `.stream-body`）；
  - `streamState(sender)` 按 sender 维护两块的引用（换回合/换人重置）；
  - `message.commit` 时把思考块头部从「思考中…」收敛为「思考过程」。
- 顺序保证：正常"先思考后回复"直接顺序追加；若回复先到、思考后到，思考块会**插入到回复之前**，
  保持"先思考、后回复"的阅读顺序。
- 历史回放（`renderEvent`/`buildThinkNode`）本来就是 `thought` 独立块 + `message` 独立气泡，无需改动。

### B. 只出思考、未出正文的兜底
- `src/application/agent-loop/loop-runner.ts`：若本回合 `content` 为空但有 reasoning，
  正文回退为平台提示「（模型本次只给出了思考过程、未输出正文；可直接重试，或调大该 provider 的 maxTokens）」，
  避免用户看到空气泡；思考仍只进 `thought` 事件，绝不作为回复正文。

### C. 分离保证的回归测试
- `tests/think-dispatch-m8f.test.ts` 新增 2 例：
  1) 思考只进 `thought` 事件、**不回灌后续上下文**（第二轮发给模型的消息里没有推理标记）、正文不含推理；
  2) 只出思考时的兜底提示生效且不含推理原文。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **118 用例全绿**（116 + 2 新增）。
- 真实模型数据链路校验（deepseek-v4-flash，WS 实测）：同一回合收到
  `thought.chunk` × 111 与 `message.chunk` × 79 **两条独立流**，首条思考在事件 #4、首条正文在 #115（思考整体在前）；
  `message.commit` 正常收尾 —— 印证前端两块分开渲染的数据基础。
- 静态资源实测：`/app.js` 含 `ensureThinkBlock`/`ensureAnswerBlock`，旧合并函数 `streamBox` 已不存在。

## 遗留（说明）

- 前端仍为无构建 ESM 静态页，无浏览器 e2e；块拆分以"数据链路 + 静态资源校验 + 代码审查"验证，未做真实点击回归。
- 思考块默认展开（便于确认模型在想什么），可点击折叠；未做"记住折叠偏好"。
