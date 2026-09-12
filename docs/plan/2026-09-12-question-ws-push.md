# 开发方案：角色提问改用 WebSocket 即时推送到对应角色会话 · 2026-09-12

> 需求来源（用户口述）："修改方式，询问用户这个应该采用 websocket 实现，在对应的角色会话中出现"

## 1. 现状与问题

- 现有链路：`ask_user` 工具 → `QuestionService.ask()` 落 `questions.jsonl` → **前端靠 HTTP 轮询** `GET /questions?status=pending`（随 `refreshPanels()` 触发，1.2s 去重 + 由别的 WS 事件间接带动）→ `renderQuestions()` 在**当前会话**渲染卡片。
- 问题：
  1. **延迟/不确定**：提问本身不产生 WS 事件，卡片何时出现取决于恰好有别的 WS 事件触发面板刷新（或 5s agent 轮询），用户会看到"角色说在等我，但卡片没出来"。
  2. **可观测性差**：DevTools 里满屏 `questions?status=pending` 返回 `{"questions":[]}`，容易被误判为接口坏了（用户本次就是这么发现的）。
  3. 提问发生在**别的角色会话**时，界面没有任何即时提示。

## 2. 设计（先盘后推 + 总线扇出，与既有 WS 一致）

1. `QuestionService` 注入 `EventBus`，在**落盘之后**推送（persist-then-push，与会话日志同规则）：
   - `question.asked`：`{ questionId, asker, kind, options, record }`，事件带 `projectId` + `sessionId`（= 提问所在角色会话）。
   - `question.answered`：`{ questionId, asker, answer }`，用于多标签页同步移除卡片。
2. 前端 `/ws` 已是"按 projectId 扇出全部会话"，因此**无需新增连接、无需按会话订阅**：一个页面一条 socket 复用现有通道。
3. 前端在**会话过滤之前**处理这两类事件（否则"别的会话的提问"会被 `e.sessionId !== current.sessionId` 丢弃）：
   - `question.asked`：把 `record` 直接插进本地 `current.questions` → `renderQuestions()` **零请求即时出卡片**；若提问不在当前会话 → toast 提示"XX 有问题要问你"，并合并刷新「需你处理」角标与团队状态。
   - `question.answered`：从本地列表移除 → `renderQuestions()`（另一标签页回答后本页同步消失）。
4. HTTP 拉取**保留为兜底对账**（断线重连/首屏/翻页后仍以服务端为准），但不再是"卡片出现的唯一途径"。

## 3. 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/application/question/question-service.ts` | 构造函数注入 `bus?: EventBus`；`ask()`/`answer()` 落盘后 `emit` 推送 |
| `src/application/composition.ts` | `new QuestionService(projectsRoot, bus)` |
| `web/app.js` | `ws.onmessage` 顶部新增 `handleQuestionPush(e)`（在会话过滤前）；本地增删 `current.questions` + `renderQuestions()`；跨会话 toast；回答成功后本地即时移除 |
| `tests/question-ws-push-m8l.test.ts` | 新增：真实 WS 连接收到 `question.asked`（含 sessionId 与 record）；`answer()` 后收到 `question.answered`；projectId 过滤不影响别的项目 |
| 文档 | 本方案 + `docs/changes/2026-09-12-question-ws-push.md` + README/设计文档同步 WS 事件表 |

## 4. 关键伪代码

```ts
// service
const rec = { ...status:'pending' }
all.push(rec); await this.writeAll(pid, all)          // 先盘
this.bus?.emit('question.asked', rec.projectId, rec.sessionId, {
  questionId: rec.id, asker: rec.asker, kind: rec.kind, options: rec.options, record: rec,
})                                                     // 后推
```

```js
// web/app.js
ws.onmessage = (evt) => {
  const e = JSON.parse(evt.data)
  if (e.type === 'question.asked' || e.type === 'question.answered') { handleQuestionPush(e); return }
  if (e.sessionId && e.sessionId !== current.sessionId) return
  ...
}
```

## 5. 验证

- `npx tsc -p tsconfig.json` / `npx eslint .` / `npx vitest run --pool=threads` 全绿。
- 新用例断言：**不轮询**、仅靠 WS 帧即可拿到提问记录；`sessionId` 正确指向提问角色会话。
- 手工：真实模型会话触发 `ask_user` → 卡片立即出现在该角色会话；切到别的会话时收到 toast + 顶部「需你处理」角标。

## 6. 边界（本轮不做）

- 不做按 `sessionId` 的 WS 订阅（总线已支持，路由仍按 projectId 全量扇出；本地单用户场景够用）。
- 不做提问超时/提醒/声音；不做多问题并排（仍保持"同一会话同时 1 个待答"）。
- 不改 `ask_user` 工具语义，不改 `questions.jsonl` 数据格式（`record` 直接复用现有类型）。
