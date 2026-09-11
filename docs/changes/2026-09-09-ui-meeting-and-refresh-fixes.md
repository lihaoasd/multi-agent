# 2026-09-09 修复会话/会议五项体验问题

> 类别：changes · 需求来源：用户反馈五条（请求风暴、提问窗口不出现、会议翻页无反应、会议无法结束、会议里出现"我的发言"）

## 逐条定位与修复

### 1) `GET /sessions` 请求风暴

**原因**：前端 WS 处理里，**每一条**其它会话的事件（别人的每个流式分片、thought、tool_call…）都会立刻发一次
`GET /api/projects/:id/sessions`；本会话的每条事件又都会调 `refreshPanels()`（一次 8 个 HTTP）。
8 个角色后台干活时就是成百上千请求。
**修复**：新增合并刷新 `scheduleRefreshPanels / scheduleRefreshUnread / scheduleRefreshAgents`
（分别 600ms / 1000ms / 800ms 去重），WS 处理只登记一次，不再逐事件发请求。

### 2) 角色询问用户但问题卡片不出现

**原因**：`refreshPanels()` 用 `Promise.all` + 一个 `catch {}` 整体包住：**任一接口失败（风暴下超时/旧版本无该路由），
所有面板都不更新**，其中就包括待回答问题卡片。
**修复**：改成各面板**互相独立**（每个请求自己 catch，成功才渲染），问题卡片独立渲染；项目/会话已切换时丢弃过期结果。

### 3) 会议里"加载更早消息"点击没反应

**原因**：会议日志前段几乎都是 `meeting_event`（不在可渲染类型里），而 `oldest` 只用**可渲染事件**计算、
翻页结果又被过滤空 → 点了等于没点（按钮也不消失）。
**修复**：`meeting_event` 纳入可渲染类型（渲染为「📋 会议 …」过程行）；翻页位置改用**全部事件**推进；
到底了给 toast「已经是最早的消息了」并收起按钮。

### 4) 会议无法结束（结论出来后应由发起人结束）

**原因**：会议讨论链跑完后没有人调用 `meeting_close`（旧数据里会议一直停在 `open`），
用户手动结束又受此前 meta 写入竞态影响（已在上一次提交修复）。
**修复**：

- 讨论链收尾（主持人总结）后**平台代发起人自动结束会议**（生成纪要）；
- 会话窗口顶部新增会议操作：`open/blocked` → **结束会议并生成纪要**；`proposed/queued` → **取消会议**；
  `closed` → 查看纪要（用户随时可结束，不必等主持人）。

### 5) 会议里出现"我的发言"

**原因**：平台注入的提示（会议开场/邀请/收尾、任务唤醒）以 `role=user, sender=user` 落盘，
前端按"用户消息"渲染成"我"。
**修复**：这些注入统一标记为**系统消息**（`sender: 'system'` + `payload.system=true`；仍以 role=user 进模型历史），
前端渲染为居中的「系统：…」提示，不再冒充用户发言。
另外：`buildHistory` 现在会**把别人的发言带进上下文**（标注 `【<名字>（实例id）发言】`），
修复"主持人在会议里读不到成员发言"的问题。

## 关键文件

`web/app.js`（合并刷新/独立面板/会议事件渲染/系统消息/会议操作按钮）、`web/style.css`、
`src/application/session/session-service.ts`（系统消息标记 + `sendUserMessage({system})`）、
`src/application/composition.ts`（任务唤醒改为系统消息）、
`src/application/agent-loop/loop-runner.ts`（历史含他人发言）、
`src/application/tools/service-tools.ts`（讨论链收尾后自动结束会议）、`tests/team-status-m8i.test.ts`。

## 验证

- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **142 用例全绿**（连跑 3 次稳定）。
  新增用例：平台注入提示为系统消息（sender=system + payload.system）；会议会话里别人的发言进入本成员上下文。
- 真实模型冒烟（deepseek-v4-flash）：PM 发起「接口与验收对齐」会议 →
  会议会话出现 `pm_1`（主持人开场）与 `dev_1`（受邀成员意见）发言 →
  注入提示 2 条**全部标记为系统消息** → 收尾后会议**自动 `closed`**，纪要 505 字。

## 遗留（说明）

- 会议讨论链仍是串行（开场 → 每人 → 收尾），人多时耗时较长；期间用户可插话/拍板/结束。
- 前端仍无浏览器 e2e：合并刷新与卡片渲染以「代码审查 + 静态资源校验 + 真实链路」验证。
