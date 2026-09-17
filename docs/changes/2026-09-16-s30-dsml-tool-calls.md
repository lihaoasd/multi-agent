# 修改记录 · S30 工具调用文本化（DSML）根因修复 + 兼容层

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s30-dsml-tool-calls.md](../plan/2026-09-16-s30-dsml-tool-calls.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §3/§7、[prd](../requirements/prd.md) FR-31 / D34

## 1. 现象 / 根因

用户报告：会话里出现一条**普通消息**，正文混着 `<||DSML|| tool_calls> … invoke name="ask_user" …>` 标记，问他"是不是拼接错了"。

**结论：不是拼接错误，是我们的 bug。** 排查证据：

| 事实 | 数值 |
| --- | --- |
| 该回合结构化工具调用 | 18 次（`fs_list_dir`/`memory_search`/`session_recent`/`task_list`）全部正常执行 |
| `ask_user` | **从未执行**（无 `question.asked`、无 `tool_call{ask_user}`） |
| 仓库内 DSML 相关代码 | **零命中** |
| 提示词里的协议说明 | 仅"你可以通过工具调用（function calling）使用下列工具" |

**根因**：`src/application/agent-loop/strategies.ts` 里**"拿到工具结果后的追问"没有带 `tools`**——`direct` 的「汇总工具结果」、`reflective` 的「结合工具结果生成初稿」、`plan-execute` 的「第 N 步结论」（本次事故点）三处都漏传。

链条：追问没带 tools → 模型想再调用工具（这里是提问）却**没有工具通道** → 它只能用自家文本协议把调用写进正文（DeepSeek 系的原生写法是 DSML）→ 适配器只读结构化 `tool_calls`，于是这段标记被当普通文本落盘 → 用户看到标记，而那一次提问从未发生（所以右栏也没有待答询问）。

连带影响：**任何"先读再写""查完再问"的多轮工具链都会在该追问轮断掉**。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 根因修复 | `src/application/agent-loop/strategies.ts` | 新增 `runToolLoop()`（`MAX_TOOL_ROUNDS = 4`）：每轮都带同一批 `toolSchemas`；模型不再要工具或预算用尽即结束（用尽时明确告知"不能再调用工具，需要决策就用自然语言说明、不要输出工具协议标记"）；`direct`/`reflective`/`plan-execute` 三处追问改走它 |
| 兼容层（新增） | `src/shared/dsml.ts` | `hasDsml()` / `extractDsmlToolCalls()`：提取正文里的 DSML 调用（多 `invoke`、参数 JSON 解析、全角竖线容错、裸 `invoke` 容错），并从正文剥离标记；解析不了计入 `unparsed` |
| 兼容层 | `src/application/agent-loop/runner.ts` | `callModel` 出口做抢救：提取到的调用**并入 `toolCalls`** 走正常工具链，正文取剥离后文本；成功识别记 `logger.warn`，识别失败落 `state` 诊断事件 |
| tests（新增） | `tests/unit/shared/dsml.test.ts` | 6 条：快路径、单次提取 + 剥离、多调用多参数、全角竖线、裸 invoke 容错、残缺片段剥离并计诊断 |
| tests | `tests/unit/application/loop-strategies.test.ts` | harness 记录每次请求的 tool schema 数；`direct` 断言汇总调用也带 tools（`[1,1]`）；新增 **S30 回归**：plan-execute 追问每轮带 tools（`[0,1,1,1]`）且追问里的工具**真被执行**（两次 `tool_call`） |
| docs | `prd` FR-31 补注 + **D34**、`design/agent-runtime.md` §3/§7、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：模型适配器（仍只读结构化 `tool_calls`，这是正确的；兼容只需在 loop 出口做一次）；工具链与策略校验（兼容层提取的调用走**同一套**闸门）；前端（"询问卡进会话流"属 S31）。

## 3. 关键决定

1. **先修根因，再加兼容**：把"追问漏传 tools"修掉，模型就**没必要**再用文本协议；兼容层只作为"服务端没转换/模型仍用文本"的兜底。只做兼容不做根因，等于长期替模型擦屁股。
2. **兼容层的调用不绕过任何闸门**：提取出的 `ToolCall` 走与结构化调用完全相同的 `runTool`（策略校验 × 会话类型 × allowedRoots × 归属 × 审批），`callId` 加 `dsml_` 前缀便于排查。
3. **纯函数放 `shared/`**：`dsml.ts` 无依赖、可被 node 侧单测覆盖（与 `shared/text.ts` 同层），避免把协议解析塞进 infra 适配器（那会让"只读结构化"的适配器承担两套协议）。
4. **用上限防"工具上瘾"**：`MAX_TOOL_ROUNDS = 4` + 既有 `toolBudget`（默认 30）双上限；预算用尽时**显式告知模型**，免得它又退回文本方言。
5. **不再让脏标记进会话**：无论解析成功还是失败，DSML 标记都会从正文剥离；失败时额外落 `state` 诊断事件，便于事后定位是哪个模型/哪次调用。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 定向单测 | `tests/unit/shared/dsml.test.ts` **6 passed**；`tests/unit/application/loop-strategies.test.ts` **9 passed**（含 S30 回归） |
| 全量测试 | `npm test` **49 files / 326 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` **142/142**（新增 `src/shared/dsml.ts` 已被用例触达，140 → 141 → 142）；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过（本轮无前端改动，产物仍 `index-CVPIKeuO.js`）；活体 200 |
| **用户实测** | 重启服务后对 PM 说一句话：应能看到**真正的询问**（右栏出现待答项）；若某次仍出现文本协议，兼容层会救回并剥离，日志里会有 `模型以文本（DSML）形式发起工具调用，已按兼容层解析` |
| 说明 | 与 S4/S7/S12/S15~S29 的交付口径一致 |

## 5. 遗留

- **右栏/会话流还不是"询问"的最终形态**：本轮只保证"提问真的发生"（落 `question.asked`），"询问卡出现在会话窗口、右栏只做提示"由 **S31** 落地。
- 兼容层只认 DSML 这一种文本协议；若将来别的模型在自己的文本方言里写工具调用（如 `<tool_call>…`），需要再加解析分支（本轮不做，避免过度设计）。
- 追问轮最多 4 轮：极少数需要"连续 5 轮以上工具"的任务会被截断（此时模型会被告知不能再调工具）。若实测发现不够，调 `MAX_TOOL_ROUNDS` 或按任务复杂度自适应（属调参）。
- 一句话教训（已写进方案）：**"模型能力"与"平台是否给它通道"是两件事**；模型输出里出现协议标记时，先查请求参数，再怀疑模型。
