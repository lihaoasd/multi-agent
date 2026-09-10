# 开发方案：Agent 工具循环（真实模型 function-calling）+ 任务上下文 + 任务级代码聚合 · 2026-09-09

> 需求来源：用户"继续"——延续上一轮（think 展示 + 甲模式任务分派），补齐最大功能缺口：
> 受派 Agent 目前只会"回话"，不能用工具读/写工作目录，任务标题以外的上下文（描述、任务归属）也拿不到。
> 目标：Agent 在自己会话中被派活后，能按角色工具白名单调用工具完成工作，改动按任务聚合、可结算为 code artifact。

## 1. 现状
- 工具执行器（`src/infra/tools/executor.ts`）与服务级工具（`service-tools.ts`）已注册，但**没有任何 Agent 工具循环**调用它们；
  仅 `app.ts` 在用户批准审批后 `resumeCommand` 执行 cmd_run。
- `ToolEnv` 无 `taskId`：`workdir_edit` 只能让模型自己传 `taskId`（可信度差）；D15 要求 dispatcher 注入当前激活任务。
- 模型网关只流式返回文本，不支持 tool_calls。

## 2. 改动范围

### A. 工具调用协议
- `provider.ts`：`ChatMessage` 支持 `role:'tool' + toolCallId`、assistant `toolCalls`；新增 `ToolSchema`；
  `ChatStreamItem` 增加 `toolCall` 增量分片（index/id/name/argumentsDelta）。
- `openai-compatible.ts`：请求带 `tools`（+`tool_choice:auto`）；消息序列化支持 tool/assistant.tool_calls；
  解析 `delta.tool_calls`。`ollama.ts`：`tools` 透传 + `message.tool_calls` 解析。`mock.ts` 不变（不产出工具调用）。
  `gateway.ts` 透传 `tools`。
- `executor.ts`：`ToolDef.paramsSchema`（function-calling 参数 schema）；`ToolEnv.taskId?`；
  为内置工具补 schema。`service-tools.ts`：补 schema；`workdir_edit` 优先用 `env.taskId`（注入值优先于模型传参）。

### B. 工具循环（loop-runner）
- `runTurnCore` 由"单次流式"升级为"至多 N 步（默认 6）"：
  1) 组装 system/history + 可用工具 → 流式对话；
  2) 有 tool_calls：落 `tool_call` 事件（参数摘要）→ 执行（`executeTool`，需审批则经 hook 建审批记录并把"待批准"回注）
     → 落 `tool_result` 事件（结果摘要截断）→ 以 `role:'tool'` 回注 → 下一步；
  3) 无 tool_calls → 收尾（文本聚合、去重空段）。
- 事件顺序：`turn_start → [plan] → (tool_call/tool_result)* → [任务分派 tool 事件] → thought → message → turn_end`。
- 注入：可用工具=角色模板 `member.tools` ∩ 注册表 ∩ `availableIn(sessionType)`；
  当前激活任务（`in_progress` 且属本会话）→ 系统提示 `[当前任务]` + `ToolEnv.taskId`。

### C. 组合接线（composition）
- `loopOpts.toolRuntime`：`listTools/exec/requestApproval/activeTask/maxSteps`。
- `composeToolEnv` 重构为 `buildToolEnv(deps, pid, iid, {taskId, sessionType})`，loop 与 app.ts 共用。

### D. 前端
- 工具审计行泛化展示（`tool_call`: 工具+参数摘要；`tool_result`: 成功/失败+结果摘要），任务分派行保持可读。

### E. 文档/测试
- 新增 `tests/tool-loop-m8g.test.ts`：fs_read_file 工具循环（含回注 tool 消息）、workdir_edit 任务级聚合（env.taskId 优先）、
  高危命令 → 审批记录 + 待批准回注。
- 真实模型冒烟：dev 会话派活后真实调用工具（fs_read_file/workdir_edit）并汇报。
- README 边界与 docs/changes 同步。

## 3. 验证
- `npx tsc -p tsconfig.json`、`npx eslint .`、`npx vitest run --pool=threads` 全绿。
- 真实 deepseek-v4-flash：工具循环真实触发、命令需审批时进入"待你处理"。

## 4. 边界（本轮不做）
- 审批通过后的"续跑结果回注 Agent"保持现状（用户批准即执行；回合不自动续跑，下一条消息可继续）。
- 通用多轮长任务续跑、meeting 内工具白名单外的平台工具（meeting_start 等）不实现。
