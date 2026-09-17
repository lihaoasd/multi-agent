# S31 方案：发送消息后输入框残留文字（乐观清空）

> 日期：2026-09-16　类型：缺陷修复（用户报告："消息发送后，消息框里会有文字"）　真源：`design/ui.md` §4
> 关联：`docs/changes/2026-09-16-s31-input-clear.md`、`docs/plan/development.md`

## 1 现象

用户在会话页发送消息后，**已发出去的文字仍留在输入框里**（发送按钮也一直处于 loading），要等很久才消失。

## 2 根因（前端等待了一个"整轮才返回"的请求）

`web/src/pages/SessionPanel.tsx` 的 `send()` 原本是**等接口返回后才清空**：

```ts
const result = await sessionApi.send(projectId, activeSessionId, text)
setDraft('')          // ← 这里才清空
```

而服务端这条接口**不会立刻返回**：`src/application/dispatcher/dispatcher.ts` 的 `submitUserMessage()` 在追加消息后：

```ts
if (!busy && !paused) {
  const drained = await drain(input.projectId, instanceId)   // ← 等整个回合跑完
  processed = drained.value.handled > 0
}
return ok({ seq, queued: !processed })
```

也就是说 **`POST /api/projects/:pid/sessions/:sid/messages` 的响应在"整个回合（模型调用 + 工具调用）结束"之后才发出**（HTTP 状态是 202，但等到回合结束）。前端既然 await 它，输入框就在这一整轮里留着刚发出去的文字，`busy` 也一直为真 → 发送按钮持续 loading/禁用。

> 旁证：prd §9 验收脚本 1 里"发消息后立刻断言 `tool_call task_assign` 出现在日志"之所以成立，正是因为这条 POST 阻塞到回合结束。

## 3 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/SessionPanel.tsx` | `send()` 改为**乐观清空**：拿到文本后**先 `setDraft('')`** 再发请求；**只有失败才把文字放回去**，且用 `setDraft((current) => current.length === 0 ? text : current)` 避免覆盖用户在等待期间新输入的内容；注释写明"接口会阻塞到回合结束，所以不能等它返回再清空" |
| docs | `docs/plan/2026-09-16-s31-input-clear.md`、`docs/changes/2026-09-16-s31-input-clear.md`、`docs/design/ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 方案/记录 + 口径回写 + 阶段索引 |

**未改**：后端接口行为（仍阻塞到回合结束）——见 §5 遗留，那是一个更值得单独处理的**设计问题**。

## 4 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| 活体 | 新产物 200 |
| **用户点验** | 发送后**输入框立刻清空**（不必等 Agent 跑完）；发送失败时文字会回到框里 |

## 5 风险与遗留

| 项 | 说明 |
| --- | --- |
| 发送失败时恢复文字的顺序 | 用函数式 `setDraft` 判断当前是否为空：用户等待期间若已重新输入，不会被旧文本覆盖 |
| **接口设计问题（本轮未改）** | `POST /messages` 在服务端 `await drain(...)`，等于**用一个 HTTP 请求承载整个回合**（可能几十秒甚至更久）。后果：① 前端 `busy` 覆盖整轮 → 发送按钮在 Agent 工作期间一直 loading/禁用，**UI 上无法用"再发一条入队"**（虽然服务端支持排队）；② 长回合有被代理/客户端超时的风险；③ "已排队"提示要等整轮结束才弹，时机失真。**修法**（需单独确认）：让路由**只负责落盘 + 派发**、立刻返回 `{seq, queued: busy || paused}`（该判断在 `loadState` 后即可得出），把 `drain` 放到后台执行；代价是测试里"POST 返回即回合完成"的假设要改成 `waitFor`（`tests/acceptance/prd-section9.test.ts` 等 3 处）。 |
| 输入框在 Agent 工作期间被禁用 | 同上（`busy` 覆盖整轮）。若先修接口，这条自然消失 |
