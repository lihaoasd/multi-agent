# 开发方案 · S4 Agent loop 与工具执行

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s4-agent-loop-tools.md)
> 关联：[agent-runtime.md](../design/agent-runtime.md) §3/§4/§7、[tools.md](../design/tools.md)、[sandbox.md](../design/sandbox.md)、[contract.md](../api/contract.md)、[abstraction.md](../design/abstraction.md) §4.3/§4.4/§4.6

## 1. 目标与范围

把 S3 的**占位回合执行器**换成真实执行：上下文组装 → 按 loop 策略编排 → 调模型（流式归一化 + 重试）→ 调工具（校验链 + 审批桥）→ 事件落盘。并补齐沙箱与策略：路径边界（含符号链接逃逸）、命令风险分级、审批落盘与跨重启语义。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `LoopRegistry` + 三个策略的**真实形态**（计划由模型产出并被消费、critique 真调用、`maxIterations`/`toolBudget` 生效） | 记忆/会话检索工具（S5）、产出物/任务/询问工具（S6） |
| `ContextBuilder`（分层拼接 + `blocks` 预览，与 system-prompt 预览同源） | 上下文摘要与长期记忆注入（S5）、任务上下文与产出索引注入（S6） |
| `ToolRegistry`/`ToolExecutor` 校验链（注册 → 会话类型 → 策略 → 审批 → 执行） | 产出物写通道（`workdir_edit`/`artifact_submit`，S6） |
| `PathResolver`（`workdir://`/`ro://`/`runtime://` + `..` 与符号链接逃逸拒绝）、`CmdRunner`（结构化 argv、超时杀进程树、输出截断） | 更强隔离后端（Docker/受限账号，预留，不做） |
| `PolicyEngine`（deny > approval > allow；命令风险表；离线拒绝联网；内置信任开关）与审批服务（落盘/等待/决定/跨重启） | 托盘批量审批、信任开关 UI（D17-④，S6/S8） |
| 只读展示：`/api/tool-packages`、`/api/tools`、`/api/loops`；前端「工具」模块与提示词预览 | 制作/卸载工具包（U8） |
| 暂停中断：`setPaused(true)` 会 abort 当前回合（可中断点），游标不推进 | 停止任务与未完成回合恢复 UI（S8） |

## 2. 关键决定

1. **策略是执行编排，不是提示**（修正 `agent-runtime.md` §3 记载的"提示级"现状）：
   - `direct`：一次模型调用；若产生工具调用，则执行**一轮**工具后再汇总一次（≤2 次调用）。
   - `reflective`：初稿 → **真 critique 调用** → 修订；轮数由 `maxIterations`（1~2）控制。
   - `plan-execute`：**计划由模型产出**（要求 JSON `{"steps":[…]}`，解析失败退化为单步）→ 落 `plan` 事件 → 逐步执行（步数受 `maxIterations` 限制、工具调用受 `toolBudget` 限制）→ 逐步回写 `plan` 进度 → 汇总 `message`。
2. **策略可中断**：每步开始前检查 `shouldInterrupt`；中断时写 `plan.status='interrupted'` 并正常收尾（不丢已落盘事件）。
3. **审批桥的真相在文件**：`approvals.jsonl` 为 append-only（状态变更追加新行，同 id 取最后一条）；决定落盘 + 唤醒进程内等待者；**跨重启 pending 保持、决定不回放**（规则 11）。
4. **`waiting` 由审批派生**：Agent 状态投影在"有占用 + 存在 pending 审批"时为 `waiting`，不新增持久化状态（与 D18-④ 真相单轨一致）。
5. **内联代码执行视为高危**（演示实测发现的策略漏洞）：`node -e` / `python -c` / `bash -c` / `powershell -Command` 等"解释器 + 内联开关"可绕过命令风险表，统一按 `CMD_INLINE_CODE` 走审批。
6. **`.env`-less 的路径根**：`runtime://` 指向 `${cwd}/data/projects/<pid>`，`ro://` 指向仓库 `src/shared`；`resolveForWrite` 只拒绝 `ro://`（workdir 与 runtime 可写）。
7. **测试装配与生产同构**：S3 建立的"录制 + 转发 Hub"广播器继续生效；S3 用例中编码占位执行器事件形状的断言，改为**结构性断言**（回合边界 + seq 连续 + agent 消息存在），不再绑定具体中间事件。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S4.1 端口 | `ports/{tools,path-resolver,policy,approval,sandbox}.ts`；`ports/turn.ts` 增 `sessionType`；`ports/tools.ts` 增 `policyAction`；tokens 20 → 23 |
| S4.2 领域规则 | `domain/rules/policy.ts`（命令风险分级 + 统一策略引擎，纯函数） |
| S4.3 infra 沙箱 | `infra/sandbox/{path-resolver,cmd-runner}.ts` |
| S4.4 infra 工具 | `infra/tools/registry.ts`（工具/工具包注册表）、`infra/tools/packages.ts`（7 个基础包元数据）、`infra/tools/builtin/index.ts`（`fs_read_file`/`fs_list_dir`/`fs_search`/`cmd_run`/`approval_query`） |
| S4.5 infra 审批 | `infra/file-store/approval-store.ts`（append-only + 锁） |
| S4.6 application | `application/approval/approval-service.ts`、`application/tools/tool-executor.ts`、`application/agent-loop/{loop,context-builder,strategies,runner,preview}.ts` |
| S4.7 server | `server/http-routes/{approvals,tools}.ts`、`projects.ts` 增 system-prompt 预览；`app.ts` 接入 |
| S4.8 装配 | `composition-root.ts`：注册沙箱/策略/审批端口，装配审批服务、工具注册表、loop 注册表、**真实 runner**（替换占位）、预览服务；`dispatcher` 接管中断与 `waiting` |
| S4.9 前端 | `api/platform.ts`、`pages/ToolsModule.tsx`、`SessionPanel` 增审批卡（批准/拒绝）、`ProjectModule` 增提示词预览弹窗；`App.tsx` 启用工具模块 |
| S4.10 测试 | 新增 5 个文件 37 条：`domain/policy`(11)、`infra/path-resolver`(6)、`application/tool-executor`(6)、`application/loop-strategies`(7)、`integration/approvals-api`(7)；另修正 3 条 S3 断言 |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc`（服务端 + 前端） | 0 错误 |
| 测试 | `vitest run` | **27 files / 184 tests 全通过**（S4 新增 37 条） |
| 门禁 | `eslint .` + ratchet | exit 0；越层违规 0（本轮曾抓出 `shared → ports` 越层，已把包元数据移到 infra） |
| 真实服务：真实 loop | 起服务后发消息 | 事件序列 `#1 message · #2 turn_start · #3 plan · #4 plan · #5 message · #6 turn_end`（plan-execute 真实形态） |
| 系统提示词预览 | `GET .../agents/dev_1/system-prompt` | blocks = `role-config / platform-role / tools / session-window`，与运行期同源 |
| 工具与 loop 清单 | `GET /api/tool-packages` `/api/tools` `/api/loops` | 7 个基础包；`fs`/`cmd`/`approval` 已注册，其余标"未实现"；三条 loop 策略可见 |
| 规则 2 路径边界 | 演示脚本 | `workdir://../outside/secret.txt` → `ERR_FORBIDDEN_PATH`；符号链接指向根外 → 同样拒绝 |
| 规则 3 高危命令审批 | 演示脚本 | 拒绝 → `ERR_APPROVAL_REJECTED` 且**命令未执行**；批准 → 落盘后执行成功；`rm -rf /` → 策略 deny；离线联网 → `ERR_NET_OFFLINE` |
| 规则 11 审批跨重启 | 演示 + 集成用例 | pending 持久化（append-only 多行同 id，最后一条为准）；列表接口重启后仍可见；决定落盘不回放 |
| 规则 26 暂停中断 | 集成用例 | 暂停后回合在可中断点结束（游标不推进、消息留在队列）；恢复补处理 |
| 前端 | `vite build` | 构建成功；新增工具模块、审批卡、提示词预览 |

## 5. 不做与遗留

- 记忆/会话检索/产出物/任务/询问工具未实现（包已声明，UI 标注"未实现"）；S5/S6 补齐。
- 托盘批量审批、信任开关 UI（D17-④）未做；策略引擎已支持 `trust` 数据源并有单测。
- 停止任务（`stop`）与未完成回合恢复三选（D17-⑤）留 S8；本轮只做"暂停 = 中断当前回合"。
- 命令沙箱仍是"逻辑沙箱"（cwd 锁定 + argv 结构化 + 风险分级 + 审批），不提供 OS 级隔离（与 design/sandbox.md 口径一致）。
- 演示脚本用完即删（`\.demo-s4.ts`），未入库。
- 端口 3000 仍被旧的 14:29 实例占用（非本轮），验收统一用 3100。
