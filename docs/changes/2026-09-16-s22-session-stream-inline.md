# 修改记录 · S22 会话流内联化（去掉事件筛选与「工作日志」折叠包装）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s22-session-stream-inline.md](../plan/2026-09-16-s22-session-stream-inline.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) D28 / FR-30 / US-18

## 1. 需求 / 问题

用户口径：**"会话聊天窗口，不要事件筛选，需要显示的话，think、工具调用。不要工作日志包装"**。

现状：会话头有一个 9 选项的**事件筛选下拉**（仅看对话 / 显示全部事件（折叠）/ 思考 / 计划 / 工具调用 / 工具结果 / 摘要 / 回合边界 / 错误），默认只显示对话；所有非对话事件被**合成一张默认折叠的 `Collapse`**（标签"工作日志 · N 条（kind…）"）——要看 Agent 的思考和工具调用得先选筛选、再展开折叠卡，两步都多余。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/SessionPanel.tsx` | 新增 `VISIBLE_KINDS`（`message`/`thought`/`tool_call`/`tool_result`/`error`）与 `toolName()`/`eventBody()`/`isToolFailed()`；`visibleEvents` 改为按 `VISIBLE_KINDS` 过滤；**删除**筛选 `Select`（9 选项）、`kindFilter` 状态、`stream` 分组逻辑、`Collapse` 折叠包装与 `isChatEvent`；思考/工具调用/结果/错误**按类别内联渲染**（思考灰底、工具调用蓝底并显示 `工具调用 <name> {args}`、结果灰底失败转红、错误红底）；空态文案改"还没有内容…"；import 去掉 `Collapse`/`Select` |
| docs | `docs/requirements/prd.md` | 新增 **D28**；改写 **FR-30**（会话流内容与"不筛选/不折叠"口径）、**US-18**、FR-12 措辞；文件头日期行增补 D28 |
| docs | `docs/design/ui.md` | §4 的界面图与「会话流内容（S22，D28）」条目改写（含"接口能力与规则 13 不变"的边界说明） |
| docs | `docs/design/architecture.md` | 对话导航描述改为"中会话流（对话/思考/工具调用内联，S22）" |
| docs | `docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md` | 阶段索引 `S0`~`S22` + S22 行；§6 验收记录；规则 13 补注"接口能力不变，S22 起 UI 不再筛选/折叠" |
| tests | `tests/acceptance/prd-section9.test.ts` | 脚本 5 阶段清单加 `s22` |

**未改**：后端与接口（`GET .../sessions/:sid/log?kind=` 的 kind 过滤**保留**，规则 13 有效）；对话气泡的左右分侧与样式；`plan`/回合边界/摘要/状态事件的数据（只是不再进会话流）。

## 3. 关键决定

1. **展示范围写死为五类**：用户点名"think、工具调用"；**工具结果跟着调用一起显示**（只有调用没有结果等于半截信息），**错误必须显示**（否则失败静默）。`plan`/回合边界/摘要/状态不进流——plan 状态在拓扑节点卡片与运行细条可见，原始流水仍可由 `?kind=` 或 Agent 工具 `session_recent` 读取。
2. **删筛选而不是给个默认值**：保留下拉但默认 `message` 会继续隐藏 think/工具调用，与需求直接冲突。
3. **内联渲染按类别区分底色**：思考/结果=灰、工具调用=蓝、失败结果与错误=红；工具调用行渲染为 `工具调用 <name> {args}`，替代原来 `JSON.stringify(payload)` 的整段 dump。
4. **接口能力与 UI 展示分离**：`?kind=` 是"原始时间线可拉取"（规则 13），与本轮"界面不再筛选"是两件事；已在 `ui.md` §4 与规则 13 显式写明，避免后续误删接口。
5. **顺带瘦身**：删掉 `Collapse` 与 `Select` 的使用后产物减小（另见 §4）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsconfig.json` + `web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-DfyeoZU2.js`，比上一版 `index-C3-RBiRI.js` 小约 10KB，符合"去掉 Collapse/Select"的预期） |
| 产物冒烟 | **不再含** `工作日志 ·`、`仅看对话`、`显示全部事件`；**含** `思考`、`工具调用`、`工具结果` |
| 回归 | `npm test` **46 files / 304 tests 全绿**（本轮无后端改动，防回归）；`npm run coverage` 140/140；`npm run ratchet` 违规 0 |
| **未覆盖** | 无浏览器自动化：需用户刷新后确认 ① 会话头没有筛选下拉 ② 思考/工具调用/结果/错误直接可见无需展开 ③ 对话气泡仍左右分侧 |
| 说明 | 与 S4/S7/S12/S15~S21 的 UI 交付口径一致：构建 + 产物冒烟 + 代码审阅 |

## 5. 遗留

- `plan` 事件不再显示在会话流里：要看"这次打算怎么做"只能去拓扑节点卡片/运行细条（plan 状态）或让 Agent 自己说明。若想显示，把 `'plan'` 加进 `VISIBLE_KINDS` 并补一条渲染分支即可。
- 工具结果长文本会完整展示（`maxWidth: 85%`），未做单条截断/折叠；若日志很长觉得刷屏，可对 `tool_result` 加 `maxHeight`（属增强）。
- 会话流一次最多加载 200 条事件（`sessionApi.detail(…, 200)`）且不再折叠，DOM 节点会比以前多；当前规模无问题，P1 可考虑虚拟滚动。
- 侧栏「审计轨迹」相关文档（`sandbox.md` §6、`agent-runtime.md` §8）提到"按 kind 过滤的事件流"指的是**接口能力**，仍然成立，未改动。
