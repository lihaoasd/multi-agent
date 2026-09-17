# S22 方案：会话流内联化（去掉事件筛选与「工作日志」折叠包装）

> 日期：2026-09-16　类型：需求变更（用户直接指令）　真源：`design/ui.md` §4（对话导航）、`prd.md` FR-30
> 关联：`docs/changes/2026-09-16-s22-session-stream-inline.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"会话聊天窗口，不要事件筛选，需要显示的话，think、工具调用。不要工作日志包装"**。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **去掉事件筛选** | 会话头不再有「仅看对话 / 显示全部事件（折叠）/ 思考 / 计划 / 工具调用 / 工具结果 / 摘要 / 回合边界 / 错误」下拉；`kindFilter` 状态与其过滤逻辑删除 |
| R2 | **内联展示思考与工具调用** | 会话流直接出现「思考」「工具调用 `<name> {args}`」，以及紧随的「工具结果」（失败标红）；不再需要展开任何东西 |
| R3 | **不要"工作日志"包装** | 非对话事件不再被合成 `Collapse`（原标签"工作日志 · N 条（kind…）"，默认折叠）；`Collapse` 与其分组逻辑删除 |
| R4 | 对话气泡保持原样 | `message` 仍按用户（右/蓝）与 Agent（左/绿）分侧展示，不引入回归 |
| R5 | 接口能力不变 | `GET /api/projects/:pid/sessions/:sid/log?kind=…` 与规则 13（原始时间线可按 kind 拉取）**保持**；本轮只改前端展示 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` | 头部有 9 选项的 `Select`（`kindFilter`）；`visibleEvents` 按筛选过滤；`stream` 把**连续非对话事件**合成一张 `Collapse`（"工作日志 · N 条"），默认折叠；气泡只对 `message` 分侧 |
| 前端 API | `web/src/api/sessions.ts` | `log(projectId, sessionId, {fromSeq, kind})`——**保留**（WS 增量拉取仍用它） |
| 后端 | `src/server/http-routes/sessions.ts` | **本轮不改**（`?kind=` 过滤能力保留，规则 13 有效） |
| 文档 | `prd` FR-30、US-18、FR-12；`design/ui.md` §4；`design/architecture.md` | FR-30 明写"默认折叠、可展开 + 仅对话/全部事件切换 + 按 kind 过滤" → 必须改 |

## 3 关键决定

1. **展示范围写死为五类**（`VISIBLE_KINDS`）：`message`、`thought`、`tool_call`、`tool_result`、`error`。用户点名"think、工具调用"；**工具结果跟着调用一起显示**（只有调用没有结果等于半截信息），**错误必须显示**（否则失败静默）。`plan`/回合边界/摘要/状态**不进流**——plan 状态在拓扑节点卡片与运行细条可见，原始流水仍可由接口或 Agent 工具读取。
2. **删筛选而不是保留默认值**：用户明确"不要事件筛选"；保留下拉但默认 `message` 会继续隐藏 think/工具调用，与 R2 冲突。
3. **内联样式按类别区分**：思考=灰底、工具调用=蓝底、工具结果=灰底（失败转红）、错误=红底；工具调用行渲染为 `工具调用 <name> {args}`，避免原来的 JSON 整段 dump 难以阅读。
4. **接口与规则 13 不动**：`?kind=` 是"原始时间线可拉取"的能力，与本轮"界面不再筛选"是两件事；在 ui.md 与规则 13 里显式写明这条边界，避免以后误删接口。
5. **代码随之瘦身**：删 `kindFilter` 状态、`isChatEvent`、`stream` 分组与 `Collapse`/`Select` import —— 产物因此小了约 10KB。

## 4 实现步骤

- `web/src/pages/SessionPanel.tsx`
  - 新增 `VISIBLE_KINDS` 常量、`toolName()`、`eventBody()`（工具调用渲染 `name(args)`）、`isToolFailed()`；删除 `isChatEvent`。
  - `visibleEvents` 改为 `events.filter(e => VISIBLE_KINDS.includes(e.kind))`；删除 `kindFilter` 状态与 `stream` 分组。
  - 头部 `extra` 去掉筛选 `Select`（保留 刷新 / 暂停 / 停止生成）。
  - 渲染：`message` 走原气泡；其余按类别内联渲染（含 `#{seq} · turn N` 次要信息）。
  - 空态文案改"还没有内容：在下面输入框说点什么"；import 去掉 `Collapse`、`Select`。
- 文档回写：`ui.md` §4（内联口径 + 界面图）、`prd`（新增 **D28**、改写 FR-30/US-18/FR-12）、`architecture.md`、`README.md`/`plan/development.md`/`testing/plan.md`（规则 13 补充说明 + §6 记录）、验收阶段清单加 `s22`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（产物应变小：去掉 `Collapse`/`Select`） |
| 产物冒烟 | 产物**不再含** `工作日志 ·`、`仅看对话`、`显示全部事件`；**含** `思考`、`工具调用`、`工具结果` |
| 回归 | `npm test` 全绿（本轮无后端改动）+ `npm run coverage` + `npm run ratchet` |
| **交互验证（用户）** | 无浏览器自动化：刷新后确认 ① 会话头没有筛选下拉 ② 思考/工具调用/结果/错误直接可见、无需展开 ③ 对话气泡仍左右分侧 |
| 说明 | 与 S4/S7/S12/S15~S21 的 UI 交付口径一致 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户其实想连 `plan` 也显示 | 只需把 `'plan'` 加进 `VISIBLE_KINDS` 并补一条渲染分支（一处常量 + 一处 label） |
| 工具结果太长刷屏 | 沿用事件文本 + `maxWidth: 85%`；如需截断，可对 `tool_result` 单独加 `maxHeight` 折叠（属增强） |
| 事件量大时 DOM 变多（不再折叠） | 当前一次最多加载 200 条事件（`sessionApi.detail(…, 200)`），且只渲染五类；如后续发现卡顿，可加虚拟滚动（P1） |
| 误以为接口也删了 | `ui.md` §4 与规则 13 已显式写明"接口能力与规则不变，只改前端展示" |
