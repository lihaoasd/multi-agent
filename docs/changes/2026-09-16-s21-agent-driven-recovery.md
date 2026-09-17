# 修改记录 · S21 未完成回合改由 Agent 自查与询问（移除平台固定恢复流程）

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s21-agent-driven-recovery.md](../plan/2026-09-16-s21-agent-driven-recovery.md)
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §7、[prd](../requirements/prd.md) D27、[ui.md](../design/ui.md) §4、[contract.md](../api/contract.md)

## 1. 需求 / 问题

用户口径：**"未完成回合的判断，应该有 agent 判断发起，询问，不能是固定流程"** —— 追问后两个问题都选了最彻底一档：**连"检测"也交给 Agent**；**"补全上次回复"也交给 Agent 判断**。

现状（S8 交付）：`RecoveryService` 用栈式配对判定"缺 `turn_end`"的回合，前端 `RecoveryBanner` 给**四个固定按钮**（汇报中断点 / 继续执行 / 补全上次回复 / 忽略），每个按钮对应一段**平台预设提示词**（`ACTION_TEXT`）注入唤醒消息——"该怎么处理"完全由平台预设，正是用户要改掉的"固定流程"。

### 实施中发现的关键约束（本轮方案的决定性输入）

用户选项里写的是"它有 `session_search`"，但**实测不成立**：`session_search` 是**关键词检索**（返回命中的会话 id/seq/片段），**看不到 `turn_start`/`turn_end` 这类边界事件**，也没有"最近事件"的时间序视图。若照现状直接删掉平台检测，就会退化成**没有任何人能发现中断**。

因此本轮的前置条件是**补一个只读事实视图**（`session_recent`），再把判断权交给 Agent。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/runtime.ts` | 删 `RecoveryAction`/`UnfinishedTurn`/`RecoveryService`/`RecoveryMarker`/`readRecoveryMarker` 与 `RuntimeAgentView.unfinishedTurn`；端口注释改为"运行控制与导出"并注明恢复已移除 |
| application | 删除 `src/application/recovery/recovery-service.ts` | 栈式配对判定 + `ACTION_TEXT` 四段预设提示词 + `resolve()` 一并删除 |
| application | `src/application/runtime/runtime-service.ts` | 去掉 `recovery` 依赖与 `unfinishedTurn` 字段 |
| application | `src/application/agent-loop/context-builder.ts` | 「平台角色定位」块新增职责：怀疑未收尾 → 先 `session_recent` 自查 → 先说明现状 → 用 `ask_user` 问，不擅自续跑 |
| infra | `src/infra/tools/builtin/memory.ts` | 新增 **`session_recent`**（`session` 包）：`SessionLogStore.readWindow` 尾窗读本会话事件，渲染 `#seq [turn N] kind ts 摘要`（`turn_start`/`turn_end` 渲染为【回合开始】/【回合结束】）；参数只有 `limit`（默认 30、上限 100）；`MemoryToolDeps` 增 `sessionLog: SessionLogStore`（**走端口，避免 infra 依赖 application**，ESLint 第 124 行禁止） |
| infra | `src/infra/tools/builtin/index.ts`、`src/infra/tools/packages.ts` | 注册与声明 `session_recent`（`session` 包工具 1 → 2） |
| roles | `src/shared/roles/*.yaml`（8 个内置模板） | `tools:` 白名单统一补 `session_recent`（否则"没人能发现中断"） |
| server | `src/server/http-routes/runtime.ts`、`src/server/app.ts` | 删三条 `/recovery` 路由与 `ACTIONS` 白名单；路由上下文去掉 `recovery` |
| bootstrap | `composition-root.ts`、`main.ts` | 去掉 RecoveryService 装配与启动自检的未完成回合统计 |
| web | `web/src/api/runtime.ts` | 删 recovery 类型/方法与 `unfinishedTurn` |
| web | 删除 `web/src/pages/RecoveryBanner.tsx`；`SessionPanel.tsx`、`WorkingBar.tsx` | 移除横幅挂载；移除细条「未完成回合」标签 |
| tests | 删除 `tests/unit/application/runtime-recovery.test.ts`；`runtime-api`、`memory-api`、`tool-packages-api`、`prd-section9` | 见 §4 |
| docs | prd（D27 + D17-⑤ 行内标注）、`agent-runtime.md` §3/§6/§7、`data-storage.md`、`memory.md`、`tools.md`、`tool-packages.md`、`ui.md` §3/§4、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md` | 全链路回写 |

## 3. 关键决定

1. **平台只保留"事实"**：删掉全部判定与固定动作；`session_recent` **只返回事件流水**（含回合边界），**不返回"未完成回合 = 第 N 个"这类结论**——否则就还是平台在替 Agent 判断。
2. **职责写进上下文而不是硬编码动作**：`platform-role` 块只描述**顺序**（自查 → 说明 → 需要决策就 `ask_user`），**不预设任何选项**；问题与选项由 Agent 自己组织，走既有 `ask_user` 通道（询问卡 + 右栏列表，D23 的 `interaction` 包）。
3. **工具走端口而非 application**：`infra` 被 ESLint 禁止依赖 `application`，因此依赖声明为端口 `SessionLogStore`（`readWindow` 是**尾窗**语义，正是"最近 N 条"），由 composition-root 注入；与 `TaskToolDeps`/`ArtifactToolDeps` 的既有约定一致。
4. **只读自己的会话**：用 `ToolContext.sessionId`，参数表里**没有 `sessionId`**（用例断言参数只有 `limit`），因此不存在越权读他人会话的入口。
5. **承认功能损失**：平台不再主动提示，**重启后若该 Agent 一直没被唤醒，中断就永远不会被发现**（D27-⑥ 明写，用户已确认接受）。
6. **历史恢复标记不迁移**：旧日志里的 `state {unfinishedTurn, recovery}` 保留但**不再被任何代码消费**；无需数据迁移（`data-storage.md` 已记明）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck | `npm run typecheck`（`tsconfig.json` + `web/tsconfig.json`）0 错误 |
| eslint | `npx eslint .` 0 错误（含 infra 未越层依赖 application） |
| 构建 | `npm run build` 通过 |
| 测试 | `npm test` **46 files / 304 tests 全绿**（删 `runtime-recovery.test.ts` 10 条；`runtime-api` 改为断言三条 `/recovery` 路径 **404** + `/runtime` 无 `unfinishedTurn`；`memory-api` 新增 `session_recent` 用例：回合边界渲染、尾窗 `limit`、参数无 `sessionId`、完整回合如实呈现；`tool-packages-api` 增 `session` 包工具与 8 个模板白名单断言） |
| 覆盖率门禁 | `npm run coverage` 触达 **140/140**（删除 `application/recovery/recovery-service.ts` 后总数 141 → 140，属预期）；`npm run ratchet` 违规 **0** |
| 契约 | 三条 `/recovery` 路径 404（集成用例）；`GET /runtime` 响应字段不含 `unfinishedTurn` |
| 工具 | `/api/tool-packages` 的 `session` 包为 `[session_search, session_recent]` 且都已注册；8 个内置模板白名单均含 `session_recent` |
| **未覆盖（需用户实测）** | 无浏览器/端到端自动化：**"重启服务后给某个 Agent 发一条消息，它是否真的先自查并主动提问"** 需用户实际跑一次确认（提示词职责 + 工具事实视图都已就位，但模型是否照做无法离线断言） |
| 说明 | 与 S4/S7/S12/S15~S20 的交付口径一致：构建 + 产物冒烟 + 代码审阅 + 集成用例 |

## 5. 遗留

- **中断可能永远不被发现**（本决策的直接代价）：只有在该 Agent 再次运行时才会自查。若要补一层"非打扰式提醒"，应作为新需求（例如在项目页会话列表给"日志里存在未收尾回合"的客观标记——但那又会回到"平台判定"，需与用户确认边界）。
- 用户侧**没有**任何"中断"提示（横幅已删）；靠 Agent 自己说明。
- `session_recent` 输出的是**原始事件摘要**，不是给模型优化过的"断点报告"；若实测发现模型读不懂（例如日志很长、limit 太小），可再调默认 `limit` 或增加"仅回合边界"过滤参数（属增强，非缺陷）。
- 拓扑页/细条不再显示"未完成回合"，但 `session_recent` 让 Agent 有了自查手段——**能力从"平台告知用户"变成"Agent 自己发现"**，这是本轮的核心取舍。
