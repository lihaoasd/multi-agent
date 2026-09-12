# 2026-09-12 任务收尾：状态上报不再丢 + 完成总结告知用户

## 需求/问题

用户两条反馈：

1. **"产品经理分派完，角色完成任务，没有修改任务状态"** —— 任务卡在「进行中」；
2. **"角色完成自己的任务后，需要总结告知用户"** —— 完成后没有面向用户的总结。

### 实测根因（读本机真实项目 `p_mtxyvrh0b800i7` 的日志）

`u_product_1` 那一回合的工具调用依次是：`fs_list_dir`(seq9) → `memory_search`(11) → `session_search`(13)
→ `workdir_edit` 初稿(17) → `workdir_edit` 修订(21) → `fs_read_file` 复核(24) → `workdir_edit` 微修(27)
= **7 次工具调用**，而 `maxSteps` 只有 **6**。

模型在 seq26 的思考里明确写着"Now register artifact and mark task done, then ask_user for the decisions"，
但**步数预算在它执行到那一步之前就用尽了** → `artifact_submit` / `task_update(done)` / `ask_user` 全部没跑，
回合在 seq29 直接 `turn_end`。于是：任务永久 `in_progress`（两条任务都是）、没有完成总结、也没有后续提问。

即：不是模型"不想上报"，是**平台把它的收尾动作截断了，而且没有任何补救**。

## 改动范围

### 一、不再截断收尾（`src/application/agent-loop/loop-runner.ts`）

- 抽出 `streamStep()`（模型流累积 + chunk 推送）与 `execToolCalls()`（审计 + 审批桥 + 结果回注），
  主循环与收尾回合共用，消除重复。
- **步数用尽 → 追加一个"收尾回合"**：只暴露 `CLOSURE_TOOLS`（`task_update`/`task_claim`/`artifact_submit`/`ask_user`），
  并注入 `WRAPUP_PROMPT`：「本回合工具步数已达上限，进入收尾：① 已完成则调用 task_update(state=done, note=总结)；
  ② 给出一段面向用户的完成总结（做了什么/产出文件/验证结果/遗留）」。
- 默认 `maxSteps` 6 → **10**（真实模型"写文档→自查→复核→登记→上报→提问"通常 7~9 步）；`composition` 同步为 10。
- **回合末兜底提示**（`remindUnreportedTask`）：本回合调过工具、却没调 `task_update` 时，往会话写一条**系统消息**
  （`role:'user' + sender:'system' + payload.system=true`，前端渲染为居中系统说明）：
  - 任务仍 `in_progress` → 「若本轮已完成，请调用 task_update(state=done, note=完成总结)…」；
  - 还有没领取的 `todo` 且本轮没 `task_claim` → 「如果你已经做完了，请先 task_claim 再 task_update(done)」。
  - 只提醒、**不替角色改状态**（状态仍由角色负责）。

### 二、完成总结（署名之外的第二条"告知用户"通道）

- `TaskRecord.resultNote`（新字段）：`setState()` 增加可选 `note`，落库并在每次状态变更时随 WS 广播。
- `task_update` 工具：`note` 真正被使用（此前 schema 里有、实现里被忽略）；`done` 且无 note 时回执提示补总结；
  描述与 `[当前任务]`/`[待领取任务]` 提示词都明确"收尾三件套"：artifact_submit → task_update(done, note=总结) → 回复里给用户总结。
- 委派人通知带上受派人总结：`【系统】你委派的任务 … 已完成（受派人 dev_1）\n受派人总结：…\n请据此安排后续`。
- 前端：`task.updated` toast 显示 `任务「X」已完成（dev_1）：<总结前 60 字>`；任务栏面板卡片显示 **完成总结/受阻原因**（`.board-summary`）。
- 领取通知与 `task_claim` 回执都带上"完成后 task_update(done, note=总结) 并给用户一段总结"。

### 三、没领取就上报也能收口

`task_update` 默认任务解析改为：显式 `taskId` > 当前进行中 > **我的最旧待领取**；
若目标是 `todo` 且属于自己 → **先自动补领取再流转**，回执注明「此前未领取，已自动补领取」。

## 测试

新增 `tests/task-completion-m8p.test.ts`（5 例）：

1. **步数用尽仍有收尾回合**：2 步写文件（= maxSteps）后，收尾回合调用 `task_update(done, note=…)` →
   任务 `done` + `resultNote` 正确 + 委派人会话收到含总结的通知 + 断言收尾提示确实注入；
2. 回合末兜底：写文件但不上报 → 会话出现 `payload.system=true` 的「仍为进行中」提示，且**平台没有替它改状态**；
3. 没领取就 `task_update(done)` → 自动补领取 + 完成 + `resultNote`；
4. WS `task.updated` 带 `resultNote`；
5. 未提供 note → 回执提醒"未提供完成总结"（不阻塞完成）。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0；`node --check web/app.js` → 0
- `npx vitest run --pool=threads` → **30 文件 / 184 用例全绿**
- ⚠️ 本轮**未做真实模型冒烟**：当前环境没有 `DEEPSEEK_API_KEY`（`$env:DEEPSEEK_API_KEY` 为空）。
  收尾回合的验证用确定性 gateway 复现了真实失败形态（预算耗尽 → 收尾动作被截断）。

## 边界

- 收尾回合只给**一次**（不循环），且只暴露结项工具；若模型在收尾回合仍不调用 `task_update`，
  平台只发兜底提示，不会自动改状态（避免把"没做完"误判成"完成"）。
- `resultNote` 只保留最近一次说明（不追加历史）；任务状态历史仍以 `tasks.jsonl` 与 session log 审计为准。
- 未做"完成总结推送到用户当前会话/角标"（目前是 toast + 任务栏卡片 + 委派人通知 + 角色会话里的回复）。
