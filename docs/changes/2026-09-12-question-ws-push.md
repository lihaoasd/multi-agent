# 2026-09-12 角色提问改用 WebSocket 推送（在对应角色会话即时出现）

## 需求/问题

用户："修改方式，询问用户这个应该采用 websocket 实现，在对应的角色会话中出现"

现状问题：`ask_user` 只落 `questions.jsonl`，**不发任何事件**；前端卡片出现完全依赖 `refreshPanels()` 定时/被动轮询 `GET /questions?status=pending`，于是

1. 卡片出现时机不确定（要等下一次面板刷新被别的 WS 事件带动），用户看到"角色说在等我，但卡片没出来"；
2. DevTools 里该接口大量返回 `{"questions":[]}`（空窗期正常现象），易被误判为接口故障；
3. 提问发生在别的角色会话时，界面毫无提示。

## 改动范围

- `src/application/question/question-service.ts`
  - 构造函数新增可选 `bus?: EventBus`（缺省不推，便于直接构造单测）。
  - `ask()`：**先盘后推** —— `writeAll` 之后 `bus.emit('question.asked', projectId, sessionId, { questionId, asker, kind, question, options, record })`。
  - `answer()`：`writeAll` 之后 `bus.emit('question.answered', projectId, sessionId, { questionId, asker, answer })`。
- `src/application/composition.ts`：`new QuestionService(projectsRoot, bus)`。
- `web/app.js`
  - `ws.onmessage` 顶部（**在 `sessionId` 过滤之前**）分流 `question.asked` / `question.answered` → `handleQuestionPush(e)`：
    - `asked`：把 `payload.record` 合并进 `current.questions` → 若 `record.sessionId === current.sessionId` 立即 `renderQuestions()`（**零 HTTP 请求**出卡片）；否则 toast「XX 有问题要问你，点顶部「需你处理」查看」；
    - `answered`：从本地列表移除 → 当前会话则重渲染；
    - 之后 `scheduleRefreshPanels()` + `scheduleRefreshAgents()` 同步「需你处理」角标与团队状态（合并刷新，不新增请求风暴）。
  - `submitQuestionAnswer()` 成功后就地移除该问题并重渲染，不等下一次轮询。
- 测试
  - 新增 `tests/question-ws-push-m8l.test.ts`（3 例，真实 WS 连接）：
    1. `ask()` 后 `injectWS('/ws?projectId=…')` 收到 `question.asked`，`sessionId` = 提问角色会话、`payload.record` 为完整记录；`answer()` 后收到 `question.answered`；
    2. 订阅别的 `projectId` 收不到本项目推送（项目隔离）；
    3. 同会话重复提问被拒时**不产生重复推送**。
  - `tests/static-web-m8k.test.ts` 增加前端接线守卫（`handleQuestionPush` / `question.asked` / `question.answered` 存在于 `app.js`）。
- 文档：`docs/plan/2026-09-12-question-ws-push.md`（方案）、`docs/api/contract.md`（WS 下行事件表补两条）、`README.md`（角色提问条目）、本记录。

## 设计说明（为什么仍保留 HTTP 拉取）

WS 是"即时通道"，HTTP `GET /questions?status=pending` 保留为**断线重连/首屏/切会话后的兜底对账**（服务端是唯一事实源）。两者并存不会重复：本地按 `id` 去重，`renderQuestions()` 渲染 `current.questions` 的当前会话子集。

## 验证结果

- `npx tsc -p tsconfig.json` → exit 0
- `npx eslint .` → exit 0
- `node --check web/app.js` → exit 0（前端语法）
- `npx vitest run --pool=threads` → **25 文件 / 152 用例全绿**（新增 3 例 WS 推送 + 1 例静态接线守卫）
- 真实网络冒烟（`tsc -p tsconfig.build.json` → `node dist` 起真实 HTTP/WS 服务 + 真实 `ws` 客户端连 `ws://127.0.0.1:3199/ws?projectId=`）：
  ```
  question.asked   → {"sessionId":"u_dev_1","qid":"q_…","status":"pending","options":["确认","取消"]}
  HTTP 兜底对账    → 1 条待答
  question.answered→ {"sessionId":"u_dev_1","qid":"q_…"}
  ```

## 边界

- 未做按 `sessionId` 的 WS 订阅（总线支持、路由仍按 projectId 扇出；本地单用户场景足够）。
- 未做提问超时提醒/声音；仍保持"同一会话同时 1 个待答问题"。
- `questions.jsonl` 数据格式与 `ask_user` 工具语义未变。
