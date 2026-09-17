# S30 方案：工具调用文本化（DSML）根因修复 + 兼容层

> 日期：2026-09-16　类型：缺陷修复（用户报告："为什么会出现 `<||DSML|| …>` 这种拼接错误？"）　真源：`design/agent-runtime.md` §3/§7、`prd.md` FR-31
> 关联：`docs/changes/2026-09-16-s30-dsml-tool-calls.md`、`docs/plan/development.md`

## 1 现象

用户在项目「贪吃蛇」的 PM 会话里看到一条**普通消息**，正文里混着工具协议标记：

```
第 1 步「需求澄清」：<||DSML|| tool_calls>
<||DSML|| invoke name="ask_user">
<||DSML|| parameter name="questions" …>[{"question":"贪吃蛇做成哪种形态？","options":[…]}]
</||DSML|| invoke>
</||DSML|| tool_calls>

第 2 步「编写需求与范围说明（doc）」：## 现状核对…
```

排查证据（真实会话日志 `data/projects/p_mu5gx818j5qh9/sessions/u_pm_1.log.jsonl`）：

| 事实 | 数值 |
| --- | --- |
| 该回合结构化工具调用 | **18 次**（`fs_list_dir`/`memory_search`/`session_recent`/`task_list`）全部正常执行 |
| `ask_user` | **从未执行**（日志无 `question.asked`、无 `tool_call{ask_user}`） |
| 全仓库 DSML 相关代码 | **零**（不是我们拼出来的） |
| 提示词里的工具协议说明 | 只有一句「你可以通过工具调用（function calling）使用下列工具」，无协议标记 |

## 2 根因（我们的 bug，不是模型"说方言"而已）

`src/application/agent-loop/strategies.ts` 里，**"拿到工具结果后的追问"没有带 `tools`**：

| 策略 | 漏传处 |
| --- | --- |
| `direct` | `汇总工具结果` 那次 `callModel` |
| `reflective` | `结合工具结果生成初稿` |
| `plan-execute` | `第 N 步结论` ← 本次事故就在这里 |

链条：**追问没带 tools** → 模型想再调用工具（这里是 `ask_user` 提问）却没有工具通道 → 它只能用自家文本协议把调用"写"进正文（DeepSeek 系的原生写法就是 DSML）→ 我们落盘时只把它当普通文本（适配器只读结构化 `tool_calls`）→ 用户在会话里看到标记，而那一次提问从未发生（所以右栏也没有待答询问）。

**"DSML 应该单独出现然后被解析成工具"这个预期是对的**，前提是请求里带了 `tools`；我们这次两个条件都不满足。

连带影响：任何"先读再写""查完再问"的多轮工具链在该追问轮**必然断掉**（模型再要工具也拿不到）。

## 3 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 根因 | `src/application/agent-loop/strategies.ts` | 新增 **`runToolLoop()`**：把"模型 → 工具 → 回注结果 → 再问"做成**有上限的循环**（`MAX_TOOL_ROUNDS = 4`），**每一轮都带同一批 `toolSchemas`**；预算用尽时明确告诉模型"本轮不能再调用工具，需要决策就用自然语言说明、不要输出任何工具协议标记"。`direct`/`reflective`/`plan-execute` 三处追问全部改走它 |
| 兼容层 | `src/shared/dsml.ts`（新增，纯函数） | `hasDsml()` / `extractDsmlToolCalls()`：从模型正文里**提取** DSML 工具调用（`tool_calls` 块内多个 `invoke`，参数按 JSON 解析、非 JSON 保留字符串；全角竖线容错；省略外层包裹的裸 `invoke` 也认），并把协议标记从正文**剥离**；解析不了的片段计 `unparsed` 供诊断 |
| 兼容层 | `src/application/agent-loop/runner.ts` | 在 `callModel` 出口做一次抢救：提取到的调用**并入本次 `toolCalls`** 走正常工具链（含策略校验/审批/询问），正文取剥离后的文本；成功识别记 `logger.warn`，识别不了则落一条 `state` 诊断事件并记日志 |
| tests | `tests/unit/shared/dsml.test.ts`（新增 6 条）、`tests/unit/application/loop-strategies.test.ts`（harness 记录每次请求的 tool schema 数 + 新增 S30 回归用例） | 见 §4 |
| docs | `prd` FR-31 补注 + **D34**、`design/agent-runtime.md` §3/§7、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：适配器（仍只读结构化 `tool_calls`——这是正确的，兼容放在 loop 出口做一次即可）；工具链与策略校验；前端（S31 处理"询问卡进会话流"）。

## 4 测试

| 用例 | 断言 |
| --- | --- |
| `tests/unit/shared/dsml.test.ts`（6 条） | 无 DSML 走快路径；单次调用提取（工具名 + JSON 参数 + 正文剥离）；多调用/多参数；全角竖线；裸 `invoke` 容错；残缺片段剥离并计入 `unparsed` |
| `loop-strategies` · direct | 汇总调用 `callToolSchemaCounts == [1, 1]`（此前第二次是 0） |
| `loop-strategies` · **S30 回归** | plan-execute 里追问**每一轮都带 tools**（`[0, 1, 1, 1]`），且追问里发出的工具调用**真的被执行**（两次 `tool_call` 事件），最终结论落进 message |

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 单测 | `npx vitest run tests/unit/shared/dsml.test.ts tests/unit/application/loop-strategies.test.ts` |
| 回归 | `npm test` 全绿 + `npm run coverage`（新增 `shared/dsml.ts` 被用例触达，142/142）+ `npm run ratchet` + `npm run build` |
| 活体 | 静态产物 200（本轮无前端改动，产物不变） |
| **用户实测** | 重启服务后对 PM 说一句话，观察它是否**真的**用结构化 `ask_user` 提问（右栏出现待答项）；若某次仍出现文本协议，现在会被兼容层救回并剥离 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 兼容层"替模型执行文本调用"带来额外风险 | 提取出的调用**走与结构化调用完全相同的链路**（策略校验 × 会话类型 × allowedRoots × 归属 × 审批），不绕过任何一道闸门；`callId` 前缀 `dsml_` 便于排查 |
| 误判普通正文里的尖括号 | 只在出现 DSML 标记时进入解析；无标记走原样快路径（有用例锁定） |
| 每轮都带 tools 让模型"上瘾"、无限调工具 | `MAX_TOOL_ROUNDS = 4` 截断 + 既有 `toolBudget`（默认 30）双重上限；预算用尽会明确告知模型改口径 |
| 追问轮执行工具后再次让 Agent 等待（提问/审批） | 与既有语义一致：`ask_user` 会真实阻塞并落 `question.asked`（S31 起在会话流内可见可答） |
