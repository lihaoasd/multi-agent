# 2026-09-09 会话 think 展示 + 任务分派（甲模式 product/pm → 自动开工）

> 类别：changes · 关联：docs/plan/2026-09-09-think-and-task-dispatch.md

## 需求/问题（用户反馈）

1. 会话中需要显示 think；agent 将要干什么需要告知用户（此前推理内容被丢弃，UI 只渲染 message）。
2. 产品经理没有安排我需要做的任务（乙模式下产品/项目经理无法把任务拆给开发）。
   用户已确认方向：开启甲模式——产品/项目经理可直接创建任务指派给开发，开发收到即自动开工。

## 改动范围

### think/意图可见（后端）
- `src/infra/model/provider.ts`：流协议升级为 `ChatStreamItem { content?, reasoning? }`；
  `mock.ts`/`openai-compatible.ts`（解析 `delta.reasoning_content`，兼容 `thinking`）/`ollama.ts`
  分别产出增量单元；`gateway.ts` 透传（`complete` 只拼 content）。
- `src/infra/bus/event-bus.ts`：新增 `emitThoughtChunk`（`thought.chunk`，不入盘）。
- `src/application/agent-loop/loop-runner.ts`：
  - 流中 reasoning → `thought.chunk` 实时推送；content 仍走 `message.chunk`；
  - 流结束有 reasoning 时以 `thought` 事件（role=agent, content.text，上限 20k 字截断）
    在 `message` 之前落盘并广播；
  - 事件顺序：`turn_start → [plan] → tool_call/tool_result(分派) → thought → message → turn_end`。

### 任务分派（甲模式）
- `config.yaml`：`task.assignByAgent: true`（运行时开甲；`config.ts` 默认仍 false，测试各自显式开/关）。
- 新 `src/application/task/task-dispatch.ts`：
  - `parseTaskIntents(text)`：解析回复中 json 代码围栏（或无围栏兜底）的任务分派数组；
    只接受带 `assignee`/`title` 的条目，去重避免围栏+兜底双解析；
  - `dispatchTasksFromText(...)`：逐条 `tasks.create`（todo）→ `start !== false` 且受派者槽位空闲
    则置 `in_progress`（触发既有"激活即唤醒 D18-③"自动开工）；忙则保持 todo 排队并说明；
    单条失败不中断；落 `tool_call/tool_result` 审计事件；返回追加进回复的「【系统 · 任务分派】」说明。
- `loop-runner.ts`：`TaskDispatchHook`（后绑定）+ 系统提示注入
  （仅 product/pm 的 user 会话、且提供了可派对象时）；eligibility = user 会话 + 角色 ∈ {pm,product} + 钩子存在。
- `composition.ts`：loop opts 改为可变对象（构造后绑定 taskDispatch，运行期读取）；
  SessionService 注入 teamLister，为 product/pm 回合填充 `ctx.assignableMembers`。

### 前端
- `web/app.js`：历史渲染支持 `message/thought/plan/tool_call/tool_result`；
  思考=折叠块「🧠 思考过程」、计划="X 计划"行、工具="X 将执行/已执行"审计行；
  流式：`thought.chunk` 实时写思考块，`message.chunk` 写正文；`event.appended` 按 seq 去重增量渲染 plan/tool 行。
- `web/style.css`：`.think/.plan/.audit/.stream-body` 样式。
- README/config 注释同步。

## 关键文件
`loop-runner.ts`、`provider/gateway/mock/openai-compatible/ollama`、`event-bus.ts`、
`task-dispatch.ts`（新）、`composition.ts`、`session-service.ts`、`config.yaml`、
`web/app.js`、`web/style.css`、README、docs/plan 方案。

## 验证
- `npx tsc -p tsconfig.json`、`npx eslint .` 通过。
- `npx vitest run --pool=threads`：113 用例全绿（原 109 + 新增 `tests/think-dispatch-m8f.test.ts` 4 例：
  解析纯函数、回合内分派→in_progress+自动开工+说明/审计、忙时排队 todo、thought 事件与 thought.chunk）。
- 真实模型冒烟：deepseek-v4-flash 会话可见思考块（thought 事件落盘）；
  product 会话派活 → 任务创建 in_progress → dev_1 收到开工消息自动回合（见 README 说明）。

## 遗留（说明）
- 通用 function-calling 工具链仍未实现；分派采用"结构化指令 + 平台执行"而非模型 tool_calls。
- meeting 会话内不分派（仅 product/pm 的 user 会话）。
- done/terminated 仍仅用户可确认。
