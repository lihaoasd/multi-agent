# 2026-09-12 任务栏面板放大 + Agent loop 轮数改为无限

## 需求/问题

用户两条：

1. **"任务面板窗口太小，任务卡片挤不下"**；
2. **"修改 agent loop 轮数，改成无限"**。

### 面板太小其实有两层原因

- **CSS 层叠被覆盖**：`.board-box` 的尺寸规则写在 `.modal-box`（通用弹窗，`width:560px; max-height:80vh`）**之前**，
  两者权重相同 → 后面的 `.modal-box` 把面板尺寸覆盖回 560px 小窗（这是"窗口太小"的主因）。
- 卡片内容被裁：`.board-desc`/`.board-summary` 有 `max-height` + `overflow:hidden`，长说明被截断；
  三列 `minmax(0,1fr)` 在窄容器里被压扁。

## 改动范围

### 一、任务栏面板（`web/style.css`）

- 选择器改为 **`.modal-box.board-box`**（权重高于 `.modal-box`，不再被覆盖）：
  `width: min(1500px, 97vw)`、`height: min(90vh, 1000px)`、`max-height: 92vh`、flex 纵向布局、`overflow: hidden`。
- **表头与底部说明常驻**：`.board-head` / `> .empty-tip` 不参与滚动。
- **三列各自滚动**：`.board-body` 占满剩余高度（`flex:1; min-height:0; overflow:auto`），
  列宽 `minmax(280px, 1fr)`（窄屏 <900px 变单列并可横向滚动）；
  `.board-col { overflow-y:auto }`，列标题 `position:sticky` 吸顶。
- **卡片不再被裁**：去掉 `.board-desc` / `.board-summary` 的 `max-height`；
  字号与行高放大（13.5px / 1.6），`word-break: break-word`；卡片间距 8px、内边距 8×10。
- 补回误删的 `button.mini`（右栏「打开面板」按钮样式）。

### 二、Agent loop 轮数改为无限（`loop-runner.ts` + `composition.ts`）

- `ToolRuntimeHook.maxSteps` 语义变更：**缺省不限制（无限轮）**，只有显式传正数才是硬上限。
  实现：`configuredSteps > 0 ? configuredSteps : Infinity`（`composition` 改为 `maxSteps: 0`）。
- **安全阀：无进展保护**——同一「工具 + 入参 + 结果」**连续 3 次**（`REPEAT_STALL_LIMIT`）判定原地空转：
  写入系统提示「检测到连续 3 次完全相同的工具调用且结果相同（原地空转），本回合已停止…」并进入收尾回合。
  出现任何不同调用即清空计数（要求"连续"）。
- 系统提示补充说明：`步数不设上限：请高效推进…同一工具+同一入参+同一结果连续 3 次会被判定空转并停止`。
- 收尾回合触发条件扩展为 **步数用尽 / 模型空手停下 / 检测到空转**；`WRAPUP_PROMPT` 文案改为不依赖"步数上限"的通用表述。

## 测试

- 新增 `tests/agent-loop-unlimited-m8s.test.ts`（3 例）：
  1. **连续 15 轮工具调用**（远超旧的 10 步上限）→ 正常跑完并给出结论（断言模型被调用 16 次、正文正确）；
  2. **原地空转**（同工具同参同结果）→ 平台在 3 次后停止、写入"原地空转"系统提示、调用次数受限（≤6）；
  3. 显式 `maxSteps: 2` 仍能作为硬上限（2 步主循环 + 1 步收尾）。
- 既有测试：`maxSteps` 显式传值的用例（4/3/2）语义不变，全部通过。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0；`node --check web/app.js` → 0
- `npx vitest run --pool=threads` → **33 文件 / 198 用例全绿**
- CSS 结构自检（括号配平 182/182）；运行中的服务 `GET /style.css` 已包含 `min(1500px…)` 与 `board-box` 规则
  （前端静态资源 no-cache，刷新即生效）。

## 边界与风险

- **无限轮 = 模型可以一直调用工具**（用户明确要求）。防跑飞只靠两条：
  ① 同调用连续重复 3 次即停（无进展保护）；② 模型不再返回工具调用时自然结束。
  **未做**每回合墙钟/费用硬上限——如果之后发现某角色长时间不收敛，建议再加"单回合最大时长/最大工具调用数"兜底。
- 面板只做了布局放大与滚动；**未做**浏览器人工目视验收（按需求只改 CSS，逻辑与数据未变）。
