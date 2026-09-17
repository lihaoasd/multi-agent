# 修改记录 · S31 发送消息后输入框残留文字（乐观清空）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s31-input-clear.md](../plan/2026-09-16-s31-input-clear.md)
> 关联设计：[ui.md](../design/ui.md) §4

## 1. 现象 / 根因

用户报告：**"消息发送后，消息框里会有文字"**（发出去的文字仍留在输入框，发送按钮一直转圈）。

**根因**：前端 `send()` **等接口返回后才清空**，而这条接口**不会立刻返回**——`dispatcher.submitUserMessage()` 在追加消息后会 `await drain(...)`（跑完整个回合：模型调用 + 工具），因此 `POST /api/projects/:pid/sessions/:sid/messages` 的响应直到**整轮结束**才发出。前端 await 它，所以：

- 输入框在整轮期间一直留着刚发出去的文字；
- `busy` 覆盖整轮 → 发送按钮持续 loading（antd loading 即禁用）。

（旁证：prd §9 脚本 1"发消息后立刻断言 `tool_call task_assign` 已入日志"成立，正因为这条 POST 阻塞到回合结束。）

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/SessionPanel.tsx` | `send()` 改为**乐观清空**：`const text = draft.trim()` → **先 `setDraft('')`** → 再 `await sessionApi.send(...)`；**失败才恢复**，且 `setDraft((current) => (current.length === 0 ? text : current))` 不覆盖等待期间的新输入；函数内注释写明"接口阻塞到回合结束，所以不能等它返回再清空" |
| docs | `docs/plan|changes/2026-09-16-s31-input-clear.md`、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 方案/记录 + 口径回写 + 阶段索引 |

**未改**：后端接口行为（仍阻塞整轮）——见 §4 遗留。

## 3. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 全量测试 | `npm test` **49 files / 326 tests 全绿**（本轮无后端改动，防回归） |
| 覆盖率门禁 | `npm run coverage` 142/142；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-gCALdmMk.js`）；活体 200 |
| **未覆盖** | 无 DOM 测试：需用户点验"发送后输入框立刻清空"与"发送失败时文字回到框里" |
| 说明 | 与 S4/S7/S12/S15~S30 的交付口径一致 |

## 4. 遗留（重要：接口设计问题，未在本轮改）

`POST /messages` 在服务端 `await drain(...)`，等于**用一个 HTTP 请求承载整个回合**。除本次症状外还有：

1. **UI 无法"再发一条入队"**：`busy` 覆盖整轮 → 发送按钮禁用；虽然服务端支持排队（忙时 `queued: true`），用户却点不了发送。
2. **长回合有超时风险**：模型 + 工具几十秒到几分钟，代理/客户端可能先超时。
3. **"已排队"提示时机失真**：要等整轮结束才弹。

**修法（需单独确认，属 S32 候选）**：路由只负责**落盘 + 派发后立即返回** `{seq, queued: busy || paused}`（该判断在 `loadState` 后即可得出，无需等 `drain`），把 `drain` 丢到后台执行（失败落 `error` 事件/日志）。代价：测试里"POST 返回即回合完成"的假设要改成 `waitFor`（至少 `tests/acceptance/prd-section9.test.ts` 三处 + `sessions-api` 若干），需要一次专门的回归。
