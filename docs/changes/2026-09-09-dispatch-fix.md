# 2026-09-09 修复「产品经理无法派单」：容错解析 + 失败回执 + task_assign 工具

> 类别：changes · 需求来源：用户反馈"产品经理无法派单，请查找问题，是怎么设计的"

## 根因（用真实会话数据定位）

导出用户贪吃蛇项目 PM 会话日志（`data/projects/p_mtvpuc0yhjnc55/sessions/u_pm_1.log.jsonl`）后复现：

- 消息 seq=24 里确实有合法的 3 条指令（`JSON.parse` 单独取 `[`…`]` 可成功，len=3）；
- 但派单**并没有生效**：`tasks.jsonl` 根本不存在，消息末尾也没有平台回执。

原因：模型把 JSON 放在 ```json 围栏里，**数组后面多输出了一个引号**：

````
```json
[{"assignee":"product_1",...}]
"          ← 多余字符
````

```

而当时的分派解析是"**把围栏内容整体 `JSON.parse`**"：多一个引号 → 解析失败 → 返回 0 条指令；
又因为"有围栏就不再走兜底"，且 **0 条指令时静默返回空串**，于是：
PM 以为自己派了单、用户以为派了单，实际一条任务都没建，**没有任何报错或提示**。

设计层面的问题有两个：
1. **解析太脆**：要求整块内容恰好是 JSON，真实模型输出常带杂质（多余引号、说明文字、多个数组、无围栏）。
2. **失败静默**：解析不到指令时不回执，用户无法察觉，Agent 也无法自我纠正。

## 改动

### A. 解析器容错重写（`src/application/task/task-dispatch.ts`）
- 不再依赖代码围栏：**扫描全文所有配对成功的 `[...]` 片段**（`balancedSlice` 处理字符串与转义），逐个 `JSON.parse`，
  取"task 形"元素（含 `assignee` + `title`）；围栏内外、多个数组都能拿到。
- 按 `assignee + title` **去重**（同一数组既在围栏又被复述时不会重复建任务）。
- 无关方括号（markdown 链接 `[文本](url)`、`["a","b"]`）解析失败即跳过，不误判。

### B. 失败必然回执（不再静默）
- 新增 `looksLikeDispatchAttempt()`：文本里出现 `assignee` 等派单特征但解析不出指令时，
  落一条 `tool_result(ok:false)` 审计事件，并在回复末尾追加
  「【系统 · 任务分派】⚠️ 未识别到有效的分派指令，本次**未创建任何任务**…请改用 task_assign 工具或输出合法 JSON」。

### C. 新增 `task_assign` 工具（推荐路径，function-calling）
- `registerServiceTools` 注册 `task_assign{assignee,title,desc?,start?}`（仅 pm/product 可调用，工具内校验角色），
  与文本协议**共用同一套核心逻辑**（`assignTaskFromIntent`：校验受派者 → 建任务 → 按需激活 → 自动唤醒）。
- 组合根把 `task_assign` 与 `ask_user` 一起列为**平台交互能力**：user 会话始终可用
  （老项目的角色快照 tools 里没有也能用）；`registerServiceTools` 调用移到 `tasks` 之后以便注入 TaskService。
- 系统提示改为**优先用工具派单**：`2. 然后调用 task_assign 工具逐个派单…`；无法调用工具时才用 JSON 数组（兼容）。

## 验证

- `npx tsc -p tsconfig.json`、`npx eslint .` 通过；`npx vitest run --pool=threads` **134 用例全绿**，新增：
  - 解析容错用例：**真实失败样例**（围栏内多余引号）、围栏+复述去重、两个独立数组、markdown 链接/普通数组不误判；
  - 「像派单但解析不了」→ 回执含"未识别到有效的分派指令/未创建任何任务"，且任务数为 0；
  - `task_assign` 工具路径 → 建任务并 `in_progress`。
- 真实数据回放：把用户那条原始消息喂给新解析器 → **3 条指令全部解析成功**。
- 真实模型冒烟（deepseek-v4-flash）：PM 会话要求"用 task_assign 派 3 个任务并立即开工" →
  **3 次 `task_assign` 工具调用**，3 个任务全部创建且 `in_progress`，
  `product_1/architect_1/dev_1` 三个受派者**全部自动开工**（各自会话出现「请开始执行任务」+ 完成回合），
  PM 还用 `ask_user` 追问了"并行 vs 串行"的风险决策。

## 遗留（说明）

- 文本协议保留兼容；但推荐模型走 `task_assign`（结构化参数，无解析风险）。
- 同一角色同时只能有 1 个 `in_progress` 任务（既有 D17-① 规则）：其余自动排队 `todo`，可在任务面板手动开工。
- `task_assign` 不能派给自己（工具会拒绝并说明）。
```
