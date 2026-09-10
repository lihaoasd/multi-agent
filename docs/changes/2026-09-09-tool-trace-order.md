# 2026-09-09 修复「工具行与回复顺序/重复行」问题（分步落盘 + 单行工具轨迹）

> 类别：changes · 需求来源：用户反馈"产品经理 将执行先出现，然后上面的对话内容才在后面出现，是什么情况"

## 问题定位（用真实会话日志验证）

导出用户那次"贪吃蛇"会话的事件时间线（`u_product_1.log.jsonl`）：

```
2  turn_start
3  tool_call fs_list_dir → 4 tool_result
5  tool_call memory_search → 6 tool_result
7  tool_call ws_write(参数非法) → 8 tool_result ✗
9  tool_call ws_write(成功) → 10 tool_result ✓
11 thought（2107 字）
12 message（那一大段 PRD 回复）
13 turn_end
```

结论：**"工具在上、回复在下"本身是时间线正确的**——模型先调 4 次工具，最后才输出正文。
但暴露两个真实缺陷：

1. **每个工具渲染两行**（"将执行" + "已执行"），4 次调用出现 8 行，噪音大、看着像顺序错乱；
2. **多步回合中工具之后才生成的正文，会被追加进工具行上方那个旧气泡**——
   而历史回放（刷新后）里正文是回合末合并成一条、落在所有工具事件之后 →
   于是"实时看到的顺序"和"刷新后看到的顺序"不一致，正是用户感到"顺序不对"的来源。

## 改动

### 后端：分步落盘（历史顺序 = 时间线）

`src/application/agent-loop/loop-runner.ts`

- 每一步流结束后，按时间顺序落盘本步的 **thought → message**（新增 `appendThought()` / `appendStepMessage()`）；
  有工具调用的步骤立即落盘，不再等回合末把所有步骤文本合并成一条 message。
- 最后一步文本仍在内存中，等甲模式分派说明生成后合并成尾部消息（保持"回复 + 【系统 · 任务分派】"同一条）。
- 新增 `callId` 到 `tool_call` / `tool_result` 审计事件（供前端把两行合并成一行）。
- 失败/无正文/只出思考的兜底逻辑保留（仍在回合末落一条消息）。

### 前端：单行工具轨迹 + 遇过程事件封口正文

`web/app.js`

- 新增 `renderToolAudit()`：`tool_call` 建行（状态"进行中"），对应 `tool_result` **回写同一行**（✓/✗ + 结果摘要），
  一次调用只占一行；按 `callId` 配对，老日志/平台动作（无 callId）按工具名队列配对兜底。
- 新增 `sealAnswerStream()`：收到 `plan` / `tool_call` / `tool_result` 时结束当前正文气泡，
  之后的正文**另起新气泡**，保证"过程 → 正文"按时间顺序排列（修掉"后续文本被塞回上方旧气泡"）。
- 历史回放与向前翻页共用同一套渲染与配对逻辑；打开会话时清空配对索引。
- `web/style.css`：工具行状态配色（进行中/完成/失败）。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **128 用例全绿**
  （新增 `tests/tool-loop-m8g.test.ts` 用例：多步回合落盘顺序为 `正文 → tool_call → tool_result → 正文`，
  且 `callId` 存在）。
- 真实模型冒烟（deepseek-v4-flash，dev 会话）：7 次真实工具调用（全部带 callId）、
  事件顺序为 `工具… → thought → message → 工具… → message → turn_end`（过程与正文交错），
  最终正文位于最后一个工具事件之后（`processBeforeFinalText=true`），落盘文件内容正确。
- 对用户已有旧日志（无 callId）：按工具名配对，8 行 → 4 行，回复仍在工具之后。

## 遗留（说明）

- 工具轨迹仍是平铺行（未做"折叠成 N 步"分组）；如需可后续加。
- 前端无浏览器 e2e：顺序修复以「事件顺序单测 + 真实模型事件时序 + 代码审查」验证。
