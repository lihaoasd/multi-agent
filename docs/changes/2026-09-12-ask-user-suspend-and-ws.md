# 2026-09-12 提问改为纯 WS + ask_user 挂起等待用户决策

## 需求/问题

用户："ask 用户的功能采用 websocket 实现，调接口的方式出现时间错位——角色还在思考，弹窗却出来了；
弹窗出来了，角色状态还没变；还会重新轮询（接口返回空数组、多调几次）。
**角色 ask 的时候应该是等待用户决策的，不应该还在执行任务。**"

三个问题分别对应：

1. **时序错位**：`ask_user` 是回合内的普通工具调用 → 提问记录**立刻**落盘并且**立刻**推 WS，
   于是角色还在同一个回合里思考/写文件时，卡片就已经出现在界面上；
2. **状态不同步**：前端团队状态刷新是 5s 合并刷新，卡片出现时左侧还显示"工作中"；
3. **仍在执行任务**：`ask_user` 只是工具结果，模型可以继续调用工具干活——与"等用户决策"的语义矛盾；
4. **多余的轮询**：`refreshPanels()` 每次刷新都拉 `/questions?status=pending`，没提问时返回 `[]`，
   DevTools 里就是"空数组 + 多次调用"。

## 改动范围

### 一、ask_user 挂起本回合（核心语义，`executor.ts` / `service-tools.ts` / `loop-runner.ts`）

- `ToolResult` 新增 `suspend?: boolean`；`ask_user` 成功时返回 `suspend: true`，
  并在工具结果里写明"本轮到此结束：你现在处于「等待用户决策」状态，不要继续执行任务"。
- `execToolCalls` 汇总该标记；主循环见到 `suspended` → **立即 break**（不再调用任何工具），
  并且**跳过收尾回合**（任务是暂停不是完成）、**跳过"任务仍未上报"的催促提示**。
- 用户回答后由既有链路唤醒新回合继续（`POST /questions/:qid/answer` → 写用户消息 + 触发回合）。

### 二、推送延迟到回合结束（`question-service.ts` / `loop-runner.ts` / `composition.ts`）

- `QuestionService.ask({ defer: true })`：**先落盘**，把提问放进内存队列，不立即广播；
  `flushPending(projectId, sessionId)` 统一广播 `question.asked`。
- `ask_user` 工具传 `defer: true`；`toolRuntime.flushDeferred` 由组合根接到 `questions.flushPending`。
- loop 在 `runDirectTurn` 的 **finally**（占用已释放、`agent.state` 已广播之后）调用 `flushDeferred`：
  顺序 = 角色消息落盘 → 回合结束 → 占用释放 → **提问卡片推送**。
  此刻 `GET /agents` 已经是 `waiting`（有待答提问且不在工作中）→ 卡片与状态同时变化。
- 顺手把 `turn_start` / `turn_end` 也广播出去（此前只落盘不广播），前端据此对齐"本轮结束"。

### 三、前端不再轮询提问（`web/app.js`）

- `refreshPanels()` 移除 `GET /questions?status=pending`（现在全文件只有 1 处调用）。
- 新增 `loadPendingQuestions(pid)`：只在**打开会话**与 **WS 打开/重连**时拉一次兜底
  （断线期间产生的提问靠这次补上）。
- 新增 `refreshAgentsNow()`：`question.asked/answered` 到达时**立即**刷新团队状态（不再等 5s 合并刷新），
  保证"卡片出现 == 状态变「等待你处理」"。
- 增删提问仍按 `id` 去重、仍沿用既有 `question.asked/answered` 处理（在会话过滤之前）。

## 测试

新增 `tests/ask-user-suspend-m8t.test.ts`（3 例，确定性 gateway + 真实 bus/occupancy）：

1. **提问后本回合立即结束**：模型只被调用 1 次、工作目录里没有产生任何后续文件、提问已落盘；
2. **推送时序**：`question.asked` 出现在 `turn_end` **之后**（断言事件顺序），且此刻 `GET /agents`
   该角色状态为 `waiting`（不是 `working`）；
3. **挂起不催任务**：不出现"任务仍为进行中，请 task_update"的系统提示，任务保持 `in_progress`（暂停而非被改状态）。

## 追加修复（同日，用户实测反馈"ask 了三次、两次失败"）

用户贴出的实测：

```
🛠 项目经理 ask_user → ✓ 已向用户提问（q_…，single）：…目标平台/形态选哪个？
🛠 项目经理 ask_user → ✗ 已有待回答的问题 q_…，请等待用户回答后再提问
🛠 项目经理 ask_user → ✗ 已有待回答的问题 q_…，请等待用户回答后再提问
```

读日志（`u_pm_1.log.jsonl` seq13/15/17，时间戳 07:38:50.520/.546/.567）确认：**挂起本身是生效的**
（seq20 立即 `turn_end`，整轮只调用模型 1 次、没有继续执行任务）。三条行来自
**模型在同一个 step 里并发给了 3 个 `ask_user`**：第一个成功，后两个撞上"同会话只允许 1 个待答"的规则而报错。

- `execToolCalls`：一旦某个调用返回 `suspend`，**同一步里后续调用直接跳过**（不再执行、也不写审计行）
  → 界面上只会出现 1 行调用，不再有"报错两次"的噪声。

### 再进一步：提问队列 + 同题去重（用户追问"为什么出现 3 个 ask_user"）

**先纠正观察**：那 3 个 `ask_user` 不是同一个问题，而是模型在**一个 step 里并发**问了 3 件不同的事
（seq13 目标平台 / seq15 功能范围 / seq17 技术栈）；两条失败信息里回显的是"已存在的那个问题"，
所以看起来像同一个问题被问了三次。

真正该修的是：后两个问题被规则挡掉后**被丢弃了**（模型本意是让老板一次拍 3 个板）。于是：

- `QuestionRecord.status` 新增 **`queued`**：同一会话已有 `pending` 时，新问题**排队**（不报错、不丢弃）；
- **同一问题去重**（文本归一化后相同 → 返回既有记录，不重建、不重复排队）；
- `answer()` 回答后**自动推进队列**：最早的 `queued` 提升为 `pending` 并推送
  → 用户答完一个，**下一张卡片立刻出现**（不用模型再跑一轮）；
- `answer()` 返回 `{ question, next }`；HTTP 层据此决定唤醒：
  `next` 非空 → `sendUserMessage(..., { wake:false })` **只写答复、不唤醒**（等全部问完再让角色继续）；
  `next` 为空 → 正常唤醒。`sendUserMessage` 新增 `wake?: boolean`（缺省 true）。
- `ask_user` 回执区分：新建待答 / **排队中** / 同一问题已存在（三者都 `suspend:true`）。

- 测试补充：同一步 3 个 `ask_user` → 只 1 次调用/1 条成功结果/1 条待答；
  不同问题排队、同一问题去重（都不推送）；回答后队首自动变待答并推送；重复提问用例断言"排队中"。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0；`node --check web/app.js` → 0
- `npx vitest run --pool=threads` → **34 文件 / 204 用例全绿**
- 前端自检：`/questions?status=pending` 在 `web/app.js` 中**只剩 1 处**（打开会话/重连的兜底）。
- 说明：本轮未在用户实时项目里注入测试消息（用户正在界面上操作，避免干扰）；
  真实模型下的 UI 表现请用户直接试一次（发一句话让角色 `ask_user`）。

## 边界

- `defer` 队列是**进程内存**：若推送前进程重启，卡片不会自动弹出（提问已落盘），
  打开会话/重连时的兜底拉取会补上。
- 仍保留 HTTP 兜底接口（`GET /questions?status=pending`）供断线与排查使用，只是不再用于轮询。
