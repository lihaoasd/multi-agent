# 2026-09-09 Agent 工具循环（function-calling）+ 任务上下文 + 任务级代码聚合

> 类别：changes · 关联：docs/plan/2026-09-09-agent-tool-loop.md

## 需求/问题（用户"继续"）

上一轮之后受派 Agent 只会"回话"：不能用工具读写工作目录，除任务标题外拿不到任务上下文，
`workdir_edit` 只能让模型自报 taskId（不可信）。本轮补齐 Agent 真正"干活"的链路。

## 改动范围

A. 模型协议支持 function-calling

- `src/infra/model/provider.ts`：`ChatMessage` 支持 `role:'tool'` + `toolCallId`、assistant `toolCalls`；
  新增 `ChatToolCall`/`ToolSchema`；`ChatStreamItem` 增加 `toolCall` 增量分片；`CompleteOptions.tools`。
- `openai-compatible.ts`：请求带 `tools`（`tool_choice:auto`）；消息序列化支持 tool/assistant.tool\_calls；
  解析 `delta.tool_calls`（index/id/name/arguments 分片）。`ollama.ts`：`tools` 透传 + `message.tool_calls` 解析。
- `gateway.ts`：`tools` 透传；`mock.ts` 不产出工具调用（离线确定性不变）。

### B. 工具循环（`loop-runner.ts`）

- 单次流式 → 至多 `maxSteps`（默认 6）步循环：流式对话 → 有 tool\_calls 则
  `tool_call` 审计事件（参数摘要，长文本截断）→ `executeTool` → `tool_result` 审计事件（结果截断）
  → 以 `role:'tool'` 回注 → 下一轮；无 tool\_calls 收尾。
- 可用工具 = 角色模板 `member.tools` ∩ 注册表 ∩ `availableIn(sessionType)`（通过 `ToolRuntimeHook` 注入）。
- `ToolRuntimeHook`：`listTools/exec/requestApproval/activeTask/maxSteps`（后绑定，见 composition）。
- 高危命令：`cmd_run` 返回 `CMD_APPROVAL_REQUIRED` → `requestApproval` 落审批记录 → 回注
  `APPROVAL_PENDING（已提交审批 ap_…）`，模型据此告知用户。
- 当前激活任务注入：系统提示 `[当前任务] …`；`ToolEnv.taskId` 注入（`workdir_edit` 归属真实任务）。
- 事件顺序：`turn_start → [plan] → (tool_call/tool_result)* → [分派审计] → thought → message → turn_end`。

### C. 工具定义/执行器

- `executor.ts`：`ToolDef.paramsSchema`（JSON Schema）+ `ToolEnv.taskId`；为 fs\_read\_file/fs\_list\_dir/ws\_write/ws\_read/cmd\_run 补 schema。
- `service-tools.ts`：memory\_\*/session\_search/workdir\_edit 补 schema；**workdir\_edit 归属优先取** **`env.taskId`**（模型自报仅兜底）。

### D. 组合接线

- `composition.ts`：`loopOpts.toolRuntime`（白名单/执行/审批/当前任务/步数上限）；`activeTaskOf`（in\_progress 且属本会话）；
  `composeToolEnv` 重构为 `buildToolEnv(deps, pid, iid, {taskId, sessionType})`，loop 与 app.ts 共用。

### E. 前端

- `web/app.js`：审计行泛化（`toolAuditDetail`）——任务分派保持可读（assignee/title），其余工具展示
  参数摘要（tool\_call）与结果摘要/错误（tool\_result）；历史与会话流一致。

### F. 存储鲁棒性（实测发现的两处并发缺陷）

- `fs-utils.atomicWriteFile`：Windows 上目标文件被并发读时 `rename` 可能 EPERM/EBUSY；
  新增 `renameWithRetry`（0/20/50/100/200/400ms 退避，仅对这三个瞬时错误码重试）。
  触发场景：dev 唤醒回合读取 tasks.jsonl 与任务状态写入并发 → 原先偶发 500 ERR\_INTERNAL（已复现并修复）。
- `session-store.appendEvent`：原先以调用方传入的 `meta` 直接 `+1` 计 seq，分派钩子等并发追加方各自读一份 meta，
  导致同一会话内 **seq 重复 / meta.lastSeq 回退**（UI 未读与增量拉取会错乱）。现改为每会话写入串行（`withLock`）
  + seq 取 `max(磁盘 lastSeq, 传入 lastSeq) + 1`，写完把最新 meta 同步回调用方；`tests/think-dispatch-m8f`
  增加"seq 严格递增且不重复"回归断言。
- `tests/unread-m7b`：等待回合结束时同步等待 `meta.lastSeq` 与 log 尾部对账（先盘后推下 meta 是投影、可能滞后），
  消除原先约 20% 的偶发失败。

## 关键文件

`src/infra/model/{provider,gateway,openai-compatible,ollama}.ts`、`src/infra/tools/executor.ts`、
`src/application/tools/service-tools.ts`、`src/application/agent-loop/loop-runner.ts`、
`src/application/composition.ts`、`src/infra/file-store/fs-utils.ts`、`web/app.js`、README、docs/plan。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **116 用例全绿**
  （新增 `tests/tool-loop-m8g.test.ts` 3 例：fs\_read\_file 循环+tool 消息回注、workdir\_edit 归属注入（伪造 taskId 被忽略）、
  高危命令→审批记录+APPROVAL\_PENDING 回注）；连续 8 次全量运行稳定（原先偶发失败已消除）。
- 真实模型冒烟（deepseek-v4-flash，dev 会话）：`fs_list_dir → fs_read_file → workdir_edit（写入 summary.md）→ fs_read_file（回读复核）`
  4 步真实工具调用，磁盘文件内容正确，回复给出验证说明。

## 遗留（说明）

- 审批通过后不自动续跑 Agent 回合（批准即执行；Agent 下一条消息继续）。
- `meeting_*`/`artifact_submit` 等平台工具尚未注册进执行器，暂不参与工具循环。
- Mock 模型无工具调用能力，离线演示时 Agent 仅对话（真实模型才有工具循环）。

