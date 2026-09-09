# 开发方案：会话内 think/意图展示 + 任务分派（甲模式）· 2026-09-09

> 需求来源（用户口述）：
> 1. 会话中需要显示 think；agent 将要干什么需要告知用户。
> 2. 产品经理没有安排我需要做的任务 → 期望：开启甲模式，产品/项目经理可直接创建任务指派给开发，开发收到即自动开工（用户已确认此方向）。

## 1. 现状与问题

- Agent 回合（`loop-runner.runTurnCore`）只消费模型文本增量（`AsyncIterable<string>`）：
  - DeepSeek 等推理型模型返回的 `reasoning_content` 被丢弃 → 会话看不到"思考/意图"。
  - UI（`web/app.js`）只渲染 `kind==='message'`，`thought/plan/tool_call` 事件全部丢弃；流式阶段只有顶部"回复中…"。
- 任务为乙模式：`config.task.assignByAgent=false`，仅 user 可创建任务（D15）；产品/项目经理在会话里无法把任务拆给开发，开发也就没有任务可执行。

## 2. 改动范围

### A. think（推理）可见 + 意图告知
1. 模型流协议升级：`ChatStreamItem = { content?, reasoning? }`。
   - `provider.ts` 类型；`mock` 只给 content；`openai-compatible` 解析 `delta.content` 与 `delta.reasoning_content`（兼容 `thinking` 别名）；`ollama` 解析 `message.content` 与 `message.reasoning_content/thinking`；`gateway` 透传。
2. `loop-runner`：
   - 增量阶段：reasoning → `bus.emit('thought.chunk', …)`；content → 原有 `message.chunk`。
   - 落盘顺序：`turn_start → [plan] → thought(若有) → message → turn_end`（均先盘后推；reasoning 截断保护默认 20000 字防爆 log）。
   - `thought` 事件 `{kind:'thought', role:'agent', sender, content:{text}}`（schema 早已预留，data-storage §4.2）。
3. `event-bus`：新增 `emitThoughtChunk`（type `thought.chunk`）。
4. 前端渲染与流式：
   - 会话历史：渲染 `thought/plan/message`（跳过 system 与 turn_start/end），think 为可折叠块（🧠 思考过程），plan 为"📋 计划"行，tool_call 为审计行。
   - 流式：`thought.chunk` 开"思考"折叠块并增量写入（未出正文时显示"思考中…"）；`message.chunk` 写答案正文；commit 收尾。
   - `agent将要干什么` 的告知载体：reasoning 过程 + plan 行 + 任务分派的 tool_call 行（见 B）。

### B. 任务分派（甲模式，product/pm 可直接派活）
1. `config.yaml`：`task.assignByAgent: true`（运行时开甲；`config.ts` 代码默认保持 false，测试自建 config 显式开/关，不破坏既有乙模式用例语义）。
2. 新模块 `src/application/task/task-dispatch.ts`：
   - `extractTaskIntents(text)`：解析回复末尾/代码围栏的 JSON 数组指令 `[{assignee,title,desc?,start?}]`（纯函数，可单测）。
   - `executeTaskDispatch(deps)`：仅当 `assignByAgent=true` 且 actor 角色 ∈ {`pm`,`product`} 且为 user 会话时执行：
     - assignee 必须在项目团队中且已启用；
     - `tasks.create(creator=actorInstanceId)` → todo；
     - `start !== false` 且受派者无 `in_progress` 槽位 → `setState(in_progress, actor=… )` → 触发既有"激活即唤醒 D18-③"（受派者 user 会话注入开工消息并自动回合一轮）；槽位占用则保持 todo 排队并在报告中说明。
     - 每项产出审计事件 `tool_call/tool_result` + 给用户的可读结果文本。
3. `AgentLoopRunner`：
   - 构造注入（可变 opts 对象，composition 后绑定）`taskDispatch?: { enabled, hint, run(ctx, text) }`；
   - 正文流完成后、`message` 落盘前执行分派；结果作为 `\n\n【系统】…` 追加进最终消息文本（诚实反馈：登记了哪些任务、谁开始执行、哪些排队/失败原因）；
   - 命中分派时同时落 `tool_call/tool_result` 审计事件（payload 摘要，不重复正文）。
   - 系统提示注入（仅启用且角色为 product/pm 的 user 会话回合）：说明可在回复末尾输出任务分派 JSON；给出可选 assignee（instanceId+显示名）。
4. `composition.ts`：loop 使用可变 opts（后绑定 taskDispatch），taskDispatch 闭包引用 projectService/teamService/tasks/sessionStore/bus；`TeamMemberConfig.roleTemplateId` 判断角色。

### C. 文档
- `docs/changes/2026-09-09-think-and-task-dispatch.md` 记录修改。
- `config.yaml` 注释、README（如相关段存在）同步一句。

## 3. 验证方式
1. `npx tsc -p tsconfig.json`、`npx eslint .`、`npx vitest run --pool=threads` 全绿。
2. 新增单测：
   - `extractTaskIntents` 解析用例（含围栏/无围栏/非法 assignee）；
   - 分派执行集成：开甲 → product 回合文本带指令 → 任务 todo→in_progress、唤醒消息出现、dev 自动回合；
   - think 落盘：假 gateway 流含 reasoning → log 中 thought 在 message 前、文本完整、`thought.chunk` 被推送。
3. 真实模型冒烟（手动/脚本）：开服 → 建项目(product+dev) → 会话要求产品经理安排任务 → 右栏任务出现、dev 会话自动开工、消息上方出现思考过程。

## 4. 不做（本次边界）
- 不实现完整 function-calling 工具循环（fs/cmd/meeting 等 Agent 自主工具仍沿用现状）；
- 不改 done/terminated 的"仅用户可确认"语义；
- 不做 meeting 内分派（仅 user 会话中 product/pm 分派）。
